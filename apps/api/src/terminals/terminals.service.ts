import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { bridge, location, punch, staffProfile, terminal, terminalEvent, user } from "../db/schema";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SKEW_LIMIT_MS = 5 * 60_000;
export type Verify = "fingerprint" | "face" | "card" | "password" | "other";
export interface EventIn { serial: string; personCode: string; ts: string; verify: Verify; state?: "in" | "out" | null }
export type EventResult = { status: "accepted" | "duplicate" | "needs_review"; reason?: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const signature = (secret: string, ts: string, body: string | Buffer) => createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");

/** Attendance terminals reach Shelfline through a LAN bridge. This is the cloud end: pairing, signature checks, and turning terminal records into punches exactly once. */
@Injectable()
export class TerminalsService {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}

  /** A bridge's signing key is derived from the server's master key and its id: nothing to store, nothing to leak from the database. Revoking the bridge is what ends it. */
  secretFor(bridgeId: string) { return createHmac("sha256", this.cfg.encryptionKey).update(`bridge:${bridgeId}`).digest("hex"); }
  private async can(userId: string, perm: "device:manage" | "timesheet:read" | "timesheet:approve", locationId: string) { if (!(await this.authz.can(userId, perm, locationId))) throw new ForbiddenException({ code: "forbidden", permission: perm, locationId }); }

  // ------------------------------------------------------------ admin: bridges and terminals
  async createBridge(orgId: string, actorId: string, v: { locationId: string; name: string }, ip: string | null) {
    const [l] = await this.db.select({ id: location.id }).from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""); const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    return this.db.transaction(async (tx) => {
      const [b] = await tx.insert(bridge).values({ orgId, locationId: v.locationId, name: v.name, pairingCodeHash: sha(raw), pairingExpiresAt: new Date(Date.now() + 15 * 60_000) }).returning();
      await this.audit.record({ orgId, actorId, action: "bridge.create", subjectType: "bridge", subjectId: b!.id, after: { name: v.name, locationId: v.locationId }, ip }, tx);
      return { id: b!.id, pairingCode: code, expiresAt: b!.pairingExpiresAt };       // shown once
    });
  }
  async renewPairing(orgId: string, actorId: string, id: string, ip: string | null) {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const [b] = await this.db.update(bridge).set({ pairingCodeHash: sha(raw), pairingExpiresAt: new Date(Date.now() + 15 * 60_000), status: "pending" }).where(and(eq(bridge.id, id), eq(bridge.orgId, orgId))).returning(); if (!b) throw new NotFoundException({ code: "bridge_not_found" });
    await this.audit.record({ orgId, actorId, action: "bridge.repair", subjectType: "bridge", subjectId: id, ip }); return { id, pairingCode: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: b.pairingExpiresAt };
  }
  async revokeBridge(orgId: string, actorId: string, id: string, ip: string | null) {
    const [b] = await this.db.update(bridge).set({ status: "revoked", pairingCodeHash: null }).where(and(eq(bridge.id, id), eq(bridge.orgId, orgId))).returning(); if (!b) throw new NotFoundException({ code: "bridge_not_found" });
    await this.audit.record({ orgId, actorId, action: "bridge.revoke", subjectType: "bridge", subjectId: id, ip }); return { status: "revoked" };
  }
  async createTerminal(orgId: string, actorId: string, v: { locationId: string; serial: string; name: string }, ip: string | null) {
    const [l] = await this.db.select({ id: location.id }).from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    try { return await this.db.transaction(async (tx) => { const [t] = await tx.insert(terminal).values({ orgId, ...v, serial: v.serial.trim() }).returning(); await this.audit.record({ orgId, actorId, action: "terminal.create", subjectType: "terminal", subjectId: t!.id, after: v, ip }, tx); return t!; }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "serial_taken" }); throw e; }
  }
  async revokeTerminal(orgId: string, actorId: string, id: string, ip: string | null) {
    const [t] = await this.db.update(terminal).set({ status: "revoked" }).where(and(eq(terminal.id, id), eq(terminal.orgId, orgId))).returning(); if (!t) throw new NotFoundException({ code: "terminal_not_found" });
    await this.audit.record({ orgId, actorId, action: "terminal.revoke", subjectType: "terminal", subjectId: id, ip }); return { status: "revoked" };
  }
  async list(orgId: string, userId: string) {
    const sc = await this.authz.scope(userId, "device:manage"); if (!sc.all && !sc.locationIds.length) return { bridges: [], terminals: [] };
    const w = sc.all ? sql`true` : sql`location_id in (${sql.join(sc.locationIds.map((i) => sql`${i}::uuid`), sql`, `)})`;
    const bs = await this.db.execute(sql`select b.id, b.name, b.status, b.location_id, l.name as location, b.paired_at, b.last_seen_at, b.last_batch_size, b.pairing_expires_at from shelfline.bridge b join shelfline.location l on l.id = b.location_id where b.org_id = ${orgId} and ${w} order by b.created_at`);
    const ts = await this.db.execute(sql`select t.id, t.serial, t.name, t.status, t.location_id, l.name as location, t.last_event_at, (select count(*)::int from shelfline.terminal_event e where e.org_id = t.org_id and e.serial = t.serial and e.received_at > now() - interval '7 days') as events_week from shelfline.terminal t join shelfline.location l on l.id = t.location_id where t.org_id = ${orgId} and ${w} order by t.created_at`);
    return { bridges: bs.rows.map((x: any) => ({ id: x.id, name: x.name, status: x.status, locationId: x.location_id, location: x.location, pairedAt: x.paired_at, lastSeenAt: x.last_seen_at, lastBatchSize: x.last_batch_size, pairingExpiresAt: x.status === "pending" ? x.pairing_expires_at : null })),
      terminals: ts.rows.map((x: any) => ({ id: x.id, serial: x.serial, name: x.name, status: x.status, locationId: x.location_id, location: x.location, lastEventAt: x.last_event_at, eventsWeek: x.events_week })) };
  }
  async setPersonCode(orgId: string, actorId: string, userId: string, code: string | null, ip: string | null) {
    const [sp] = await this.db.select().from(staffProfile).where(and(eq(staffProfile.userId, userId), eq(staffProfile.orgId, orgId))); if (!sp) throw new NotFoundException({ code: "staff_not_found" });
    if (code) { const [dupe] = await this.db.select({ id: staffProfile.userId }).from(staffProfile).where(and(eq(staffProfile.orgId, orgId), sql`${staffProfile.userId} <> ${userId}`, sql`coalesce(${staffProfile.terminalPersonCode}, ${staffProfile.employeeCode}) = ${code}`)); if (dupe) throw new ConflictException({ code: "person_code_taken" }); }
    await this.db.update(staffProfile).set({ terminalPersonCode: code }).where(eq(staffProfile.userId, userId));
    await this.audit.record({ orgId, actorId, action: "terminal.person_code", subjectType: "user", subjectId: userId, before: { code: sp.terminalPersonCode }, after: { code }, ip }); return { code };
  }

  // ------------------------------------------------------------ the bridge's side
  /** One-time exchange of the short pairing code for the bridge's identity and signing key. */
  async pair(code: string) {
    const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, ""); const [b] = await this.db.select().from(bridge).where(and(eq(bridge.pairingCodeHash, sha(raw)), eq(bridge.status, "pending")));
    if (!b || !b.pairingExpiresAt || b.pairingExpiresAt < new Date()) throw new BadRequestException({ code: "invalid_pairing_code" });
    await this.db.update(bridge).set({ status: "active", pairingCodeHash: null, pairingExpiresAt: null, pairedAt: new Date() }).where(eq(bridge.id, b.id));
    const [l] = await this.db.select().from(location).where(eq(location.id, b.locationId)); await this.audit.record({ orgId: b.orgId, actorKind: "system", action: "bridge.paired", subjectType: "bridge", subjectId: b.id });
    return { bridgeId: b.id, secret: this.secretFor(b.id), locationId: b.locationId, location: l!.name, timezone: l!.timezone };
  }
  /** Checks the signature over `<timestamp>.<exact body>` and that the timestamp is recent (a captured request cannot be replayed later). */
  async authenticate(bridgeId: string | undefined, ts: string | undefined, sig: string | undefined, raw: Buffer | undefined) {
    if (!bridgeId || !ts || !sig || !raw || !/^[0-9a-f-]{36}$/i.test(bridgeId)) throw new UnauthorizedException({ code: "bridge_auth" });
    const t = Number(ts); if (!Number.isFinite(t) || Math.abs(Date.now() - t * 1000) > SKEW_LIMIT_MS) throw new UnauthorizedException({ code: "bridge_stale_request" });
    const [b] = await this.db.select().from(bridge).where(eq(bridge.id, bridgeId)); if (!b || b.status !== "active") throw new UnauthorizedException({ code: "bridge_auth" });
    const want = Buffer.from(signature(this.secretFor(b.id), ts, raw), "hex"), got = Buffer.from(sig, "hex"); if (want.length !== got.length || !timingSafeEqual(want, got)) throw new UnauthorizedException({ code: "bridge_auth" });
    return b;
  }

  /** Each record becomes at most one punch: the row in terminal_event is unique per (terminal, person, device time), so a resend finds it and does nothing. */
  async ingest(b: typeof bridge.$inferSelect, events: EventIn[]): Promise<EventResult[]> {
    const out: EventResult[] = [];
    for (const e of events) out.push(await this.one(b, e));
    await this.db.update(bridge).set({ lastSeenAt: new Date(), lastBatchSize: events.length }).where(eq(bridge.id, b.id)); return out;
  }
  private async one(b: typeof bridge.$inferSelect, e: EventIn): Promise<EventResult> {
    const ts = new Date(e.ts); const serial = e.serial.trim();
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(terminal).where(and(eq(terminal.orgId, b.orgId), eq(terminal.serial, serial)));
      const [sp] = await tx.select({ userId: staffProfile.userId }).from(staffProfile).innerJoin(user, eq(user.id, staffProfile.userId)).where(and(eq(staffProfile.orgId, b.orgId), eq(user.status, "active"), sql`coalesce(${staffProfile.terminalPersonCode}, ${staffProfile.employeeCode}) = ${e.personCode}`));
      const problem = !t || t.status !== "active" ? "unknown_terminal" : t.locationId !== b.locationId ? "terminal_elsewhere" : !sp ? "unknown_person" : null;
      const [row] = await tx.insert(terminalEvent).values({ orgId: b.orgId, bridgeId: b.id, serial, personCode: e.personCode, ts, verify: e.verify, state: e.state ?? null, status: problem ? "needs_review" : "accepted", reason: problem, userId: sp?.userId ?? null, locationId: t?.locationId ?? b.locationId }).onConflictDoNothing().returning();
      if (!row) return { status: "duplicate" as const };
      if (t) await tx.update(terminal).set({ lastEventAt: sql`greatest(coalesce(${terminal.lastEventAt}, ${ts}), ${ts})` }).where(eq(terminal.id, t.id));
      if (problem) return { status: "needs_review" as const, reason: problem };
      const p = await this.punchFor(tx, b.orgId, sp!.userId, b.locationId, ts, e.state ?? null, t!.id);
      await tx.update(terminalEvent).set({ punchId: p }).where(eq(terminalEvent.id, row.id)); return { status: "accepted" as const };
    });
  }
  /** In or out: what the terminal says when it says, otherwise the opposite of the person's last punch before this moment. */
  private async punchFor(tx: Pick<Db, "execute" | "insert">, orgId: string, userId: string, locationId: string, ts: Date, state: "in" | "out" | null, deviceId: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 2))`);
    let kind = state;
    if (!kind) { const r = await tx.execute(sql`select p.kind from shelfline.punch p where p.org_id = ${orgId} and p.user_id = ${userId} and p.location_id = ${locationId} and p.client_ts <= ${ts} and not exists (select 1 from shelfline.punch q where q.supersedes_id = p.id) order by p.client_ts desc, p.received_at desc limit 1`); kind = (r.rows[0] as { kind?: string } | undefined)?.kind === "in" ? "out" : "in"; }
    const id = crypto.randomUUID(); await tx.insert(punch).values({ id, orgId, userId, locationId, kind, method: "terminal_fp", sourceDeviceId: deviceId, clientTs: ts, status: "accepted" }); return id;
  }

  // ------------------------------------------------------------ review of what could not be matched
  async review(orgId: string, userId: string, o: { locationId: string; status?: string }) {
    await this.can(userId, "timesheet:read", o.locationId);
    const rows = await this.db.select().from(terminalEvent).where(and(eq(terminalEvent.orgId, orgId), eq(terminalEvent.locationId, o.locationId), eq(terminalEvent.status, o.status ?? "needs_review"))).orderBy(desc(terminalEvent.ts)).limit(200);
    return rows.map((r) => ({ id: r.id, serial: r.serial, personCode: r.personCode, ts: r.ts, verify: r.verify, reason: r.reason, status: r.status }));
  }
  async resolve(orgId: string, actorId: string, id: string, v: { userId: string }, ip: string | null) {
    const [e] = await this.db.select().from(terminalEvent).where(and(eq(terminalEvent.id, id), eq(terminalEvent.orgId, orgId))); if (!e) throw new NotFoundException({ code: "event_not_found" }); await this.can(actorId, "timesheet:approve", e.locationId!);
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(terminalEvent).where(eq(terminalEvent.id, id)).for("update"); if (cur!.status !== "needs_review") throw new ConflictException({ code: "event_not_pending", status: cur!.status });
      const [u] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, v.userId), eq(user.orgId, orgId), eq(user.status, "active"))); if (!u) throw new NotFoundException({ code: "user_not_found" });
      const [t] = await tx.select().from(terminal).where(and(eq(terminal.orgId, orgId), eq(terminal.serial, cur!.serial)));
      const p = await this.punchFor(tx, orgId, v.userId, cur!.locationId!, cur!.ts, cur!.state as "in" | "out" | null, t?.id ?? cur!.id);
      await tx.update(terminalEvent).set({ status: "accepted", userId: v.userId, punchId: p, resolvedBy: actorId, resolvedAt: new Date() }).where(eq(terminalEvent.id, id));
      await this.audit.record({ orgId, actorId, action: "terminal_event.resolve", subjectType: "terminal_event", subjectId: id, after: { userId: v.userId, personCode: cur!.personCode, punchId: p }, ip }, tx); return { punchId: p };
    });
  }
  async dismiss(orgId: string, actorId: string, id: string, ip: string | null) {
    const [e] = await this.db.select().from(terminalEvent).where(and(eq(terminalEvent.id, id), eq(terminalEvent.orgId, orgId))); if (!e) throw new NotFoundException({ code: "event_not_found" }); await this.can(actorId, "timesheet:approve", e.locationId!);
    const r = await this.db.update(terminalEvent).set({ status: "dismissed", resolvedBy: actorId, resolvedAt: new Date() }).where(and(eq(terminalEvent.id, id), eq(terminalEvent.status, "needs_review"))).returning({ id: terminalEvent.id }); if (!r.length) throw new ConflictException({ code: "event_not_pending" });
    await this.audit.record({ orgId, actorId, action: "terminal_event.dismiss", subjectType: "terminal_event", subjectId: id, after: { personCode: e.personCode }, ip }); return { status: "dismissed" };
  }
  /** Who is clocked in, as the server sees it: the last standing punch, wherever it came from. The till shows this so a fingerprint clock-in appears there. */
  async myStatus(orgId: string, userId: string, locationId: string) {
    const r = await this.db.execute(sql`select p.kind, p.client_ts, p.method, t.name as terminal from shelfline.punch p left join shelfline.terminal t on t.id = p.source_device_id where p.org_id = ${orgId} and p.user_id = ${userId} and p.location_id = ${locationId} and not exists (select 1 from shelfline.punch q where q.supersedes_id = p.id) order by p.client_ts desc, p.received_at desc limit 1`);
    const x = r.rows[0] as { kind: string; client_ts: Date; method: string; terminal: string | null } | undefined; return x ? { state: x.kind, at: x.client_ts, method: x.method, terminal: x.terminal } : { state: null, at: null, method: null, terminal: null };
  }
}
