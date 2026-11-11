import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException, HttpException } from "@nestjs/common";
import * as argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { generate, generateSecret, generateURI, verify } from "otplib";
import { AuditService } from "../audit/audit.service";
import { decrypt, encrypt, sha256Hex } from "../common/crypto";
import { RateLimiter } from "../common/ratelimit";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { device, org, staffProfile, user, userAssignment } from "../db/schema";
import { AuthzService } from "./authz.service";
import { TokenService } from "./tokens";

// Hash of a random string: verified against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = await argon2.hash("not-a-real-password-" + Math.random(), { type: argon2.argon2id });
export const hashSecret = (s: string) => argon2.hash(s, { type: argon2.argon2id });

@Injectable()
export class AuthService {
  private loginLimiter = new RateLimiter(10, 60_000);
  constructor(
    @Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(TokenService) private tokens: TokenService,
    @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService,
  ) {}

  async login(email: string, password: string, totp: string | undefined, ip: string | null, orgSlug?: string) {
    const key = `${ip ?? "?"}|${email.toLowerCase()}`;
    if (!this.loginLimiter.take(key)) throw new HttpException({ code: "rate_limited" }, 429);
    // The same email can exist in more than one organisation. Every account with that email is checked against the password (so the time taken says nothing about how many exist);
    // if several accept it, the person is asked which organisation, and only after the password was right.
    const found = await this.db.select({ u: user, slug: org.slug, orgName: org.name }).from(user).innerJoin(org, eq(org.id, user.orgId)).where(and(sql`lower(${user.email}) = ${email.toLowerCase()}`, orgSlug ? eq(org.slug, orgSlug.toLowerCase()) : undefined));
    const checks = await Promise.all((found.length ? found : [undefined]).map(async (r) => {
      const hash = r?.u.passwordHash ?? DUMMY_HASH; const right = await argon2.verify(hash, password).catch(() => false);
      return { r, ok: !!r && !!r.u.passwordHash && r.u.status === "active" && right };
    }));
    const good = checks.filter((c) => c.ok);
    if (good.length === 0) { const first = found[0]; if (first) await this.audit.record({ orgId: first.u.orgId, actorId: first.u.id, action: "auth.login_failed", ip }); throw new UnauthorizedException({ code: "invalid_credentials" }); }
    if (good.length > 1) throw new ConflictException({ code: "choose_org", orgs: good.map((c) => ({ slug: c.r!.slug, name: c.r!.orgName })) });
    const u = good[0]!.r!.u;
    if (u.totpEnabled) {
      if (!totp) throw new UnauthorizedException({ code: "totp_required" });
      const valid = (await verify({ secret: decrypt(u.totpSecretEnc!, this.cfg.encryptionKey), token: totp })).valid;
      if (!valid) {
        await this.audit.record({ orgId: u.orgId, actorId: u.id, action: "auth.totp_failed", ip });
        throw new UnauthorizedException({ code: "invalid_credentials" });
      }
    }
    this.loginLimiter.clear(key);
    await this.audit.record({ orgId: u.orgId, actorId: u.id, action: "auth.login", ip });
    return this.tokens.issue({ userId: u.id, orgId: u.orgId, aud: "admin" });
  }

  async totpSetup(userId: string) {
    const [u] = await this.db.select().from(user).where(eq(user.id, userId));
    if (!u) throw new UnauthorizedException();
    if (u.totpEnabled) throw new ForbiddenException({ code: "totp_already_enabled" });
    const secret = generateSecret();
    await this.db.update(user).set({ totpSecretEnc: encrypt(secret, this.cfg.encryptionKey) }).where(eq(user.id, userId));
    return { secret, otpauthUri: generateURI({ issuer: "Shelfline", label: u.email, secret }) };
  }

  async totpEnable(userId: string, orgId: string, code: string) {
    const [u] = await this.db.select().from(user).where(eq(user.id, userId));
    if (!u?.totpSecretEnc) throw new ForbiddenException({ code: "totp_not_set_up" });
    if (!(await verify({ secret: decrypt(u.totpSecretEnc, this.cfg.encryptionKey), token: code })).valid) throw new UnauthorizedException({ code: "invalid_code" });
    await this.db.update(user).set({ totpEnabled: true }).where(eq(user.id, userId));
    await this.audit.record({ orgId, actorId: userId, action: "auth.totp_enabled", subjectType: "user", subjectId: userId });
  }

  /** Shared by sign-in and manager approval: device check, lockout, PIN check. Throws the same generic errors either way. */
  async verifyPin(deviceKey: string | undefined, employeeCode: string, pin: string, ip: string | null) {
    if (!deviceKey) throw new UnauthorizedException({ code: "device_required" });
    const [d] = await this.db.select().from(device).where(eq(device.keyHash, sha256Hex(deviceKey)));
    if (!d || d.status !== "active" || d.kind !== "pos") throw new UnauthorizedException({ code: "device_invalid" });
    await this.db.update(device).set({ lastSeenAt: new Date() }).where(eq(device.id, d.id));

    const [row] = await this.db.select({ sp: staffProfile, u: user }).from(staffProfile).innerJoin(user, eq(user.id, staffProfile.userId))
      .where(and(eq(staffProfile.orgId, d.orgId), eq(staffProfile.employeeCode, employeeCode))).limit(1);
    const generic = new UnauthorizedException({ code: "invalid_pin" });
    if (!row || row.u.status !== "active" || !row.sp.pinHash) { await argon2.verify(DUMMY_HASH, pin).catch(() => false); throw generic; }
    if (row.sp.pinLockedUntil && row.sp.pinLockedUntil > new Date())
      throw new HttpException({ code: "pin_locked", until: row.sp.pinLockedUntil.toISOString() }, 423);

    if (!(await argon2.verify(row.sp.pinHash, pin).catch(() => false))) {
      const attempts = row.sp.pinAttempts + 1;
      const lock = attempts >= this.cfg.pinMaxAttempts ? new Date(Date.now() + this.cfg.pinLockMinutes * 60_000) : null;
      await this.db.update(staffProfile).set({ pinAttempts: lock ? 0 : attempts, pinLockedUntil: lock }).where(eq(staffProfile.userId, row.u.id));
      await this.audit.record({ orgId: d.orgId, actorId: row.u.id, actorKind: "device", action: lock ? "auth.pin_locked" : "auth.pin_failed", deviceId: d.id, ip });
      throw generic;
    }
    return { d, u: row.u };
  }

  /** A manager enters their PIN on the till (online) to approve one thing; the signed token travels with the sale. */
  async approve(deviceKey: string | undefined, managerCode: string, pin: string, kind: "discount" | "variance" | "refund", ip: string | null) {
    const { d, u } = await this.verifyPin(deviceKey, managerCode, pin, ip);
    const needed = kind === "discount" ? "sale:approve_discount" : "cash:approve";
    if (!(await this.authz.can(u.id, needed, d.locationId))) {
      await this.audit.record({ orgId: d.orgId, actorId: u.id, actorKind: "device", action: "authz.denied", detail: { permission: needed }, deviceId: d.id, ip });
      throw new ForbiddenException({ code: "cannot_approve" });
    }
    await this.db.update(staffProfile).set({ pinAttempts: 0, pinLockedUntil: null }).where(eq(staffProfile.userId, u.id));
    await this.audit.record({ orgId: d.orgId, actorId: u.id, actorKind: "device", action: "sale.approval_granted", detail: { kind }, deviceId: d.id, ip });
    return { approvalToken: await this.tokens.issueApproval({ approverId: u.id, orgId: d.orgId, deviceId: d.id, locationId: d.locationId, kind }), approver: { id: u.id, name: u.name }, expiresInSec: 600 };
  }

  async pinLogin(deviceKey: string | undefined, employeeCode: string, pin: string, ip: string | null) {
    const { d, u } = await this.verifyPin(deviceKey, employeeCode, pin, ip);
    const row = { u };
    // The cashier must work at this device's location (a location-specific assignment or an organisation-wide one).
    const assigned = await this.db.select({ l: userAssignment.locationId }).from(userAssignment).where(eq(userAssignment.userId, row.u.id));
    if (!assigned.some((a) => a.l === null || a.l === d.locationId)) {
      await this.audit.record({ orgId: d.orgId, actorId: row.u.id, actorKind: "device", action: "authz.denied", detail: { reason: "not assigned to device location" }, deviceId: d.id, ip });
      throw new ForbiddenException({ code: "not_assigned_to_location" });
    }
    await this.db.update(staffProfile).set({ pinAttempts: 0, pinLockedUntil: null }).where(eq(staffProfile.userId, row.u.id));
    await this.audit.record({ orgId: d.orgId, actorId: row.u.id, actorKind: "device", action: "auth.pin_login", deviceId: d.id, ip });
    return { ...(await this.tokens.issue({ userId: row.u.id, orgId: d.orgId, aud: "pos", deviceId: d.id })), locationId: d.locationId, registerId: d.registerId };
  }
}
