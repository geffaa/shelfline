import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../auth/tokens";
import { decrypt, encrypt } from "../common/crypto";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { org, ssoConnection, ssoTicket, user } from "../db/schema";
import { OidcError, authorizeUrl, discover, exchangeCode, newNonce, newVerifier, type Identity } from "./oidc";

const STATE_TTL = "10m"; const TICKET_TTL_MS = 60_000;

@Injectable()
export class SsoService {
  private key: Uint8Array;
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(AuditService) private audit: AuditService, @Inject(TokenService) private tokens: TokenService) { this.key = new TextEncoder().encode(cfg.jwtSecret); }
  private redirectUri() { return `${this.cfg.publicApiUrl}/auth/sso/callback`; }

  // ---------------------------------------------------------------- configuration (owner)
  async get(orgId: string) { const [c] = await this.db.select().from(ssoConnection).where(eq(ssoConnection.orgId, orgId)); return c ? { configured: true, issuer: c.issuer, clientId: c.clientId, emailDomains: c.emailDomains, enabled: c.enabled, redirectUri: this.redirectUri() } : { configured: false, redirectUri: this.redirectUri() }; }
  async set(orgId: string, actorId: string, v: { issuer: string; clientId: string; clientSecret?: string; emailDomains: string[]; enabled: boolean }, ip: string | null) {
    const issuer = v.issuer.trim().replace(/\/$/, "");
    try { await discover(issuer); } catch (e) { throw new BadRequestException({ code: e instanceof OidcError ? `sso_${e.code}` : "sso_provider_invalid" }); }
    const [old] = await this.db.select().from(ssoConnection).where(eq(ssoConnection.orgId, orgId));
    const secret = v.clientSecret?.trim() || (old ? decrypt(old.clientSecretEnc, this.cfg.encryptionKey) : ""); if (!secret) throw new BadRequestException({ code: "sso_secret_required" });
    const domains = [...new Set(v.emailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
    await this.db.transaction(async (tx) => {
      await tx.insert(ssoConnection).values({ orgId, issuer, clientId: v.clientId.trim(), clientSecretEnc: encrypt(secret, this.cfg.encryptionKey), emailDomains: domains, enabled: v.enabled })
        .onConflictDoUpdate({ target: ssoConnection.orgId, set: { issuer, clientId: v.clientId.trim(), clientSecretEnc: encrypt(secret, this.cfg.encryptionKey), emailDomains: domains, enabled: v.enabled, updatedAt: new Date() } });
      await this.audit.record({ orgId, actorId, action: "sso.configure", subjectType: "org", subjectId: orgId, after: { issuer, clientId: v.clientId.trim(), emailDomains: domains, enabled: v.enabled }, ip }, tx);
    });
    return this.get(orgId);
  }
  async remove(orgId: string, actorId: string, ip: string | null) { await this.db.transaction(async (tx) => { await tx.delete(ssoConnection).where(eq(ssoConnection.orgId, orgId)); await this.audit.record({ orgId, actorId, action: "sso.remove", subjectType: "org", subjectId: orgId, ip }, tx); }); }

  // ---------------------------------------------------------------- signing in
  /** Step 1: where to send the browser. Everything the callback needs travels in a signed, short-lived `state`, so nothing is kept here between the two steps. */
  async start(slug: string, hint?: string) {
    const [row] = await this.db.select({ id: org.id, c: ssoConnection }).from(org).innerJoin(ssoConnection, eq(ssoConnection.orgId, org.id)).where(and(eq(org.slug, slug.toLowerCase()), eq(ssoConnection.enabled, true)));
    if (!row) throw new NotFoundException({ code: "sso_not_available" });
    const d = await this.disc(row.c.issuer); const nonce = newNonce(); const verifier = newVerifier();
    const state = await new SignJWT({ org: row.id, nonce, verifier }).setProtectedHeader({ alg: "HS256" }).setAudience("sso-state").setIssuedAt().setExpirationTime(STATE_TTL).sign(this.key);
    return { url: authorizeUrl(d, { clientId: row.c.clientId, redirectUri: this.redirectUri(), state, nonce, verifier, loginHint: hint }) };
  }
  private async disc(issuer: string) { try { return await discover(issuer); } catch (e) { throw new BadRequestException({ code: e instanceof OidcError ? `sso_${e.code}` : "sso_provider_invalid" }); } }

  /** Step 2: the provider sent the browser back. Returns where to send it next; never throws to the browser, because a failed sign-in is a page, not a stack trace. */
  async callback(q: { code?: string; state?: string; error?: string }, ip: string | null): Promise<string> {
    const back = (o: Record<string, string>) => `${this.cfg.adminUrl}/#/sso?${new URLSearchParams(o)}`;
    if (q.error) return back({ error: "provider_refused" });
    if (!q.code || !q.state) return back({ error: "bad_request" });
    let st: { org: string; nonce: string; verifier: string };
    try { st = (await jwtVerify(q.state, this.key, { audience: "sso-state", algorithms: ["HS256"] })).payload as unknown as typeof st; } catch { return back({ error: "state_invalid" }); }
    const [c] = await this.db.select().from(ssoConnection).where(and(eq(ssoConnection.orgId, st.org), eq(ssoConnection.enabled, true))); if (!c) return back({ error: "not_available" });
    let who: Identity;
    try { who = await exchangeCode(await discover(c.issuer), { clientId: c.clientId, clientSecret: decrypt(c.clientSecretEnc, this.cfg.encryptionKey), redirectUri: this.redirectUri(), code: q.code, verifier: st.verifier, nonce: st.nonce }); }
    catch (e) { await this.audit.record({ orgId: st.org, actorKind: "system", action: "sso.login_failed", after: { reason: e instanceof OidcError ? e.code : "error" }, ip }); return back({ error: "sign_in_failed" }); }
    const refuse = async (reason: string) => { await this.audit.record({ orgId: st.org, actorKind: "system", action: "sso.login_failed", after: { reason, email: who.email }, ip }); return back({ error: "not_allowed" }); };
    if (!who.emailVerified) return refuse("email_not_verified");
    if (c.emailDomains.length && !c.emailDomains.includes(who.email.split("@")[1] ?? "")) return refuse("domain_not_allowed");
    const [u] = await this.db.select().from(user).where(and(eq(user.orgId, st.org), sql`lower(${user.email}) = ${who.email}`));
    if (!u || u.status !== "active" || u.portalOnly) return refuse("no_such_user");                                          // signing in does not create anyone
    const [t] = await this.db.insert(ssoTicket).values({ orgId: st.org, userId: u.id, expiresAt: new Date(Date.now() + TICKET_TTL_MS) }).returning({ id: ssoTicket.id });
    return back({ ticket: t!.id });
  }

  /** Step 3: the page trades its one-time ticket for a sign-in. Used once, atomically; a second try, a late try, or a made-up one all look the same. */
  async exchange(ticket: string, ip: string | null) {
    const [t] = await this.db.update(ssoTicket).set({ usedAt: new Date() }).where(and(eq(ssoTicket.id, ticket), sql`${ssoTicket.usedAt} is null`, sql`${ssoTicket.expiresAt} > now()`)).returning();
    if (!t) throw new UnauthorizedException({ code: "invalid_ticket" });
    const [u] = await this.db.select().from(user).where(and(eq(user.id, t.userId), eq(user.status, "active"))); if (!u) throw new UnauthorizedException({ code: "invalid_ticket" });
    await this.audit.record({ orgId: t.orgId, actorId: u.id, action: "auth.login", after: { method: "sso" }, ip });
    return this.tokens.issue({ userId: u.id, orgId: t.orgId, aud: "admin" });
  }
}
