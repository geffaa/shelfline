import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Subscription } from "rxjs";
import { MailService } from "../access/mail.service";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { location, notification, notificationRule, NOTIFICATION_KINDS, role, user } from "../db/schema";
import { EventsService } from "../reporting/events.service";
import { matchShift } from "../workforce/pairing";
import { money, nextDigest, plan, ruleMatches, type NotifyEvent, type RuleFacts } from "./engine";

type Row = Record<string, unknown>;
export interface RuleIn { name: string; eventKind: (typeof NOTIFICATION_KINDS)[number]; locationIds: string[] | null; conditions: { minMinor?: number; minLateMinutes?: number; varianceOverMinor?: number }; recipientUserIds: string[]; recipientRoles: string[]; channels: string[]; quietStart: string | null; quietEnd: string | null; critical: boolean; digest: boolean; digestAt: string; active: boolean }
const factsOf = (r: typeof notificationRule.$inferSelect): RuleFacts => ({ id: r.id, eventKind: r.eventKind, locationIds: r.locationIds, conditions: r.conditions as RuleFacts["conditions"], channels: r.channels, quietStart: r.quietStart, quietEnd: r.quietEnd, critical: r.critical, digest: r.digest, digestAt: r.digestAt, active: r.active });
const SOURCE_KINDS = new Set(["cash", "session", "punch", "refund"]);

/** Turns what happens at the tills into messages. The event path is immediate (LISTEN/NOTIFY); a sweep every 30 seconds picks up anything that was missed and releases held messages. Both are safe to repeat: a message is unique per (rule, person, event). */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private sub: Subscription | null = null; private timer: NodeJS.Timeout | null = null; private logger = new Logger("notifications");
  constructor(@Inject(DB) private db: Db, @Inject(EventsService) private events: EventsService, @Inject(MailService) private mail: MailService, @Inject(AuditService) private audit: AuditService) {}
  onModuleInit() {
    this.sub = this.events.events.subscribe((e) => { if (SOURCE_KINDS.has(e.kind)) void this.process(e.org, e.kind, e.id).catch((err) => this.logger.warn(`process ${e.kind}: ${String(err)}`)); });
    this.timer = setInterval(() => { void this.sweep().catch((err) => this.logger.warn(`sweep: ${String(err)}`)); }, 30_000); this.timer.unref();
  }
  onModuleDestroy() { this.sub?.unsubscribe(); if (this.timer) clearInterval(this.timer); }

  // ------------------------------------------------------------ from a source row to events
  async eventsFor(orgId: string, kind: string, id: string): Promise<NotifyEvent[]> {
    if (kind === "cash") {
      const [r] = (await this.db.execute(sql`select cm.id, cm.kind, cm.reason, cm.location_id, l.name as location, rg.name as register, u.name as actor from shelfline.cash_movement cm join shelfline.location l on l.id = cm.location_id join shelfline.register rg on rg.id = cm.register_id left join shelfline."user" u on u.id = cm.actor_id where cm.id = ${id} and cm.org_id = ${orgId}`)).rows as Row[];
      if (!r || r.kind !== "no_sale") return [];
      return [{ kind: "no_sale", ref: `cash:${id}`, locationId: r.location_id as string, severity: r.reason ? "info" : "warning", title: `No-sale at ${r.location}`, body: `${r.actor ?? "Someone"} opened the drawer on ${r.register} without a sale. ${r.reason ? `Reason: ${r.reason}.` : "No reason was given."}`, facts: {} }];
    }
    if (kind === "session") {
      const [r] = (await this.db.execute(sql`select s.id, s.status, s.opening_float_minor, s.counted_close_minor, s.expected_close_minor, s.variance_minor, s.location_id, l.name as location, rg.name as register, u.name as opener from shelfline.register_session s join shelfline.location l on l.id = s.location_id join shelfline.register rg on rg.id = s.register_id left join shelfline."user" u on u.id = s.opened_by where s.id = ${id} and s.org_id = ${orgId}`)).rows as Row[];
      if (!r) return [];
      const base = { locationId: r.location_id as string }; const out: NotifyEvent[] = [];
      if (r.status === "open") out.push({ ...base, kind: "register_open", ref: `session:${id}:open`, severity: "info", title: `${r.register} opened at ${r.location}`, body: `${r.opener ?? "Someone"} opened ${r.register} with a float of ${money(Number(r.opening_float_minor))}.`, facts: {} });
      else {
        out.push({ ...base, kind: "register_close", ref: `session:${id}:close`, severity: "info", title: `${r.register} closed at ${r.location}`, body: `Counted ${money(Number(r.counted_close_minor ?? 0))} against ${money(Number(r.expected_close_minor ?? 0))} expected.`, facts: { varianceMinor: Number(r.variance_minor ?? 0) } });
        const v = Number(r.variance_minor ?? 0);
        if (r.variance_minor !== null) out.push({ ...base, kind: "cash_variance", ref: `session:${id}:variance`, severity: Math.abs(v) >= 5000 ? "critical" : "warning", title: `${v < 0 ? "Short" : "Over"} ${money(v)} at ${r.location}`, body: `${r.register} closed ${v < 0 ? "short" : "over"} by ${money(v)}: counted ${money(Number(r.counted_close_minor ?? 0))}, expected ${money(Number(r.expected_close_minor ?? 0))}.`, facts: { varianceMinor: v } });
      }
      return out;
    }
    if (kind === "punch") {
      const [p] = (await this.db.execute(sql`select p.id, p.kind, p.status, p.user_id, p.location_id, p.client_ts, l.name as location, u.name as person from shelfline.punch p join shelfline.location l on l.id = p.location_id join shelfline."user" u on u.id = p.user_id where p.id = ${id} and p.org_id = ${orgId}`)).rows as Row[];
      if (!p || p.status !== "accepted") return [];
      const base = { locationId: p.location_id as string }; const out: NotifyEvent[] = [{ ...base, kind: p.kind === "in" ? "punch_in" : "punch_out", ref: `punch:${id}`, severity: "info", title: `${p.person} clocked ${p.kind === "in" ? "in" : "out"} at ${p.location}`, body: `${p.person} clocked ${p.kind === "in" ? "in" : "out"} at ${p.location}.`, facts: {} }];
      if (p.kind === "in") {
        const at = new Date(String(p.client_ts)).getTime();
        const shifts = (await this.db.execute(sql`select id, starts_at, ends_at, break_minutes from shelfline.shift where user_id = ${p.user_id as string} and location_id = ${p.location_id as string} and published_at is not null and starts_at between ${new Date(at - 12 * 3_600_000).toISOString()}::timestamptz and ${new Date(at + 4 * 3_600_000).toISOString()}::timestamptz`)).rows as Row[];
        const sh = matchShift(at, shifts.map((s) => ({ id: s.id as string, startsAt: new Date(String(s.starts_at)).getTime(), endsAt: new Date(String(s.ends_at)).getTime(), breakMinutes: Number(s.break_minutes) })));
        const late = sh ? Math.round((at - sh.startsAt) / 60_000) : 0;
        if (sh && late > 0) out.push({ ...base, kind: "late_arrival", ref: `late:${id}`, severity: "warning", title: `${p.person} is ${late} min late at ${p.location}`, body: `${p.person} clocked in ${late} minutes after the start of their shift.`, facts: { lateMinutes: late } });
      }
      return out;
    }
    if (kind === "refund") {
      const [r] = (await this.db.execute(sql`select r.id, r.total_minor, r.reason, r.tender, r.location_id, l.name as location, u.name as actor from shelfline.refund r join shelfline.location l on l.id = r.location_id left join shelfline."user" u on u.id = r.actor_id where r.id = ${id} and r.org_id = ${orgId}`)).rows as Row[];
      if (!r) return [];
      return [{ kind: "large_refund", ref: `refund:${id}`, locationId: r.location_id as string, severity: "warning", title: `Refund of ${money(Number(r.total_minor))} at ${r.location}`, body: `${r.actor ?? "Someone"} refunded ${money(Number(r.total_minor))} to ${String(r.tender).replace("_", " ")}. Reason: ${r.reason}.`, facts: { amountMinor: Number(r.total_minor) } }];
    }
    return [];
  }

  async process(orgId: string, kind: string, id: string) { let n = 0; for (const e of await this.eventsFor(orgId, kind, id)) n += await this.dispatch(orgId, e); return n; }

  // ------------------------------------------------------------ from an event to people
  private async recipients(orgId: string, r: typeof notificationRule.$inferSelect, locationId: string | null): Promise<string[]> {
    const ids = new Set(r.recipientUserIds);
    if (r.recipientRoles.length) {
      const rows = await this.db.execute(sql`select distinct ua.user_id from shelfline.user_assignment ua join shelfline.role ro on ro.id = ua.role_id where ro.org_id = ${orgId} and ro.key in (${sql.join(r.recipientRoles.map((k) => sql`${k}`), sql`, `)}) and (ua.location_id is null ${locationId ? sql`or ua.location_id = ${locationId}::uuid` : sql``})`);
      for (const x of rows.rows) ids.add(String(x.user_id));
    }
    if (!ids.size) return [];
    return (await this.db.select({ id: user.id }).from(user).where(and(eq(user.orgId, orgId), eq(user.status, "active"), eq(user.portalOnly, false), inArray(user.id, [...ids])))).map((u) => u.id);
  }

  /** Returns how many new messages were made. Repeating the same event makes none. */
  async dispatch(orgId: string, e: NotifyEvent, now = new Date()): Promise<number> {
    const rules = (await this.db.select().from(notificationRule).where(and(eq(notificationRule.orgId, orgId), eq(notificationRule.eventKind, e.kind), eq(notificationRule.active, true)))).filter((r) => ruleMatches(factsOf(r), e));
    if (!rules.length) return 0;
    const [loc] = e.locationId ? await this.db.select({ tz: location.timezone }).from(location).where(eq(location.id, e.locationId)) : [];
    const tz = loc?.tz ?? "UTC"; let made = 0;
    for (const r of rules) {
      for (const uid of await this.recipients(orgId, r, e.locationId)) {
        const d = plan(factsOf(r), e, now, tz);
        const [row] = await this.db.insert(notification).values({ orgId, ruleId: r.id, userId: uid, eventKind: e.kind, eventRef: e.ref, locationId: e.locationId, title: e.title, body: e.body, payload: e.facts as never, severity: e.severity, status: d.status, emailStatus: d.emailStatus === "sent" ? "sent" : d.emailStatus, heldUntil: d.heldUntil, deliveredAt: d.status === "delivered" ? now : null }).onConflictDoNothing().returning({ id: notification.id });
        if (!row) continue; made++;
        if (d.emailStatus === "sent") await this.email(orgId, uid, e.title, e.body, "notification");
        if (d.status === "delivered") await this.ping(orgId, e.locationId, row.id);
      }
    }
    return made;
  }

  private async email(orgId: string, userId: string, subject: string, body: string, kind: string) { const [u] = await this.db.select({ email: user.email }).from(user).where(eq(user.id, userId)); if (u) await this.mail.send(orgId, { to: u.email, subject, body, kind }); }
  private async ping(orgId: string, locationId: string | null, id: string) { await this.db.execute(sql`select pg_notify('shelfline_events', ${JSON.stringify({ org: orgId, loc: locationId, kind: "notification", id })})`); }

  // ------------------------------------------------------------ held messages, summaries, and missed events
  /** Quiet hours ended: show held messages and send their email (or queue it for the summary if the rule is a digest). */
  async release(now = new Date()) {
    const rows = await this.db.select({ n: notification, digest: notificationRule.digest }).from(notification).innerJoin(notificationRule, eq(notificationRule.id, notification.ruleId)).where(and(eq(notification.status, "held"), sql`${notification.heldUntil} <= ${now.toISOString()}::timestamptz`));
    for (const { n, digest } of rows) {
      const email = n.emailStatus === "held" ? (digest ? "digest" : "sent") : n.emailStatus;
      const [done] = await this.db.update(notification).set({ status: "delivered", emailStatus: email, deliveredAt: now }).where(and(eq(notification.id, n.id), eq(notification.status, "held"))).returning({ id: notification.id });
      if (!done) continue;
      if (n.emailStatus === "held" && !digest) await this.email(n.orgId, n.userId, n.title, n.body, "notification");
      await this.ping(n.orgId, n.locationId, n.id);
    }
    return rows.length;
  }
  /** One summary email per person for everything waiting whose summary time has come. */
  async sendDigests(now = new Date()) {
    const rows = await this.db.select({ n: notification, at: notificationRule.digestAt, tz: location.timezone }).from(notification).innerJoin(notificationRule, eq(notificationRule.id, notification.ruleId)).leftJoin(location, eq(location.id, notification.locationId))
      .where(and(eq(notification.emailStatus, "digest"), eq(notification.status, "delivered")));
    const due = rows.filter((r) => nextDigest(r.n.createdAt, r.at, r.tz ?? "UTC").getTime() <= now.getTime()); const by = new Map<string, typeof due>();
    for (const r of due) (by.get(`${r.n.orgId}:${r.n.userId}`) ?? by.set(`${r.n.orgId}:${r.n.userId}`, []).get(`${r.n.orgId}:${r.n.userId}`)!).push(r);
    for (const [, list] of by) {
      const first = list[0]!.n; const marked = await this.db.update(notification).set({ emailStatus: "digested" }).where(and(inArray(notification.id, list.map((x) => x.n.id)), eq(notification.emailStatus, "digest"))).returning({ id: notification.id });
      if (marked.length) await this.email(first.orgId, first.userId, `Shelfline summary: ${marked.length} update${marked.length === 1 ? "" : "s"}`, list.sort((a, b) => a.n.createdAt.getTime() - b.n.createdAt.getTime()).map((x) => `- ${x.n.title}`).join("\n"), "notification_digest");
    }
    return by.size;
  }
  /** Look again at what happened lately, in case a live notice was lost while the server was down, then release and summarise. */
  async sweep(now = new Date()) {
    const since = new Date(now.getTime() - 3 * 3_600_000).toISOString(); let made = 0;
    const src = (await this.db.execute(sql`
      select 'cash' as k, id::text, org_id::text as org from shelfline.cash_movement where kind = 'no_sale' and at > ${since}::timestamptz
      union all select 'session', id::text, org_id::text from shelfline.register_session where coalesce(closed_at, opened_at) > ${since}::timestamptz
      union all select 'punch', id::text, org_id::text from shelfline.punch where received_at > ${since}::timestamptz
      union all select 'refund', id::text, org_id::text from shelfline.refund where at > ${since}::timestamptz`)).rows as Row[];
    for (const r of src) made += await this.process(String(r.org), String(r.k), String(r.id));
    return { made, released: await this.release(now), digests: await this.sendDigests(now) };
  }

  // ------------------------------------------------------------ rules (admin)
  private async check(orgId: string, v: RuleIn) {
    if (!v.recipientUserIds.length && !v.recipientRoles.length) throw new BadRequestException({ code: "no_recipients" });
    if ((v.quietStart === null) !== (v.quietEnd === null)) throw new BadRequestException({ code: "quiet_needs_both" });
    if (v.locationIds) { if (!v.locationIds.length) throw new BadRequestException({ code: "no_locations" }); const f = await this.db.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, v.locationIds))); if (f.length !== new Set(v.locationIds).size) throw new NotFoundException({ code: "location_not_found" }); }
    if (v.recipientUserIds.length) { const f = await this.db.select({ id: user.id }).from(user).where(and(eq(user.orgId, orgId), eq(user.portalOnly, false), inArray(user.id, v.recipientUserIds))); if (f.length !== new Set(v.recipientUserIds).size) throw new NotFoundException({ code: "user_not_found" }); }
    if (v.recipientRoles.length) { const f = await this.db.select({ key: role.key }).from(role).where(and(eq(role.orgId, orgId), inArray(role.key, v.recipientRoles))); if (f.length !== new Set(v.recipientRoles).size) throw new BadRequestException({ code: "unknown_role" }); }
    const allowed: Record<string, string[]> = { large_refund: ["minMinor"], late_arrival: ["minLateMinutes"], cash_variance: ["varianceOverMinor"] };
    for (const k of Object.keys(v.conditions)) if (!(allowed[v.eventKind] ?? []).includes(k)) throw new BadRequestException({ code: "condition_not_for_kind", condition: k });
  }
  async listRules(orgId: string) {
    const rows = await this.db.select().from(notificationRule).where(eq(notificationRule.orgId, orgId)).orderBy(desc(notificationRule.createdAt));
    const sent = new Map((await this.db.execute(sql`select rule_id::text as id, count(*)::int as n, max(created_at) as last from shelfline.notification where org_id = ${orgId} group by rule_id`)).rows.map((r) => [String(r.id), r as Row]));
    const users = new Map((await this.db.select({ id: user.id, name: user.name }).from(user).where(eq(user.orgId, orgId))).map((u) => [u.id, u.name])); const locs = new Map((await this.db.select({ id: location.id, name: location.name }).from(location).where(eq(location.orgId, orgId))).map((l) => [l.id, l.name]));
    return rows.map((r) => ({ ...r, locations: r.locationIds ? r.locationIds.map((i) => locs.get(i) ?? "?") : null, recipients: r.recipientUserIds.map((i) => users.get(i) ?? "?"), sent: Number(sent.get(r.id)?.n ?? 0), lastAt: sent.get(r.id)?.last ?? null }));
  }
  async createRule(orgId: string, actorId: string, v: RuleIn, ip: string | null) {
    await this.check(orgId, v);
    return this.db.transaction(async (tx) => { const [r] = await tx.insert(notificationRule).values({ orgId, ...v, createdBy: actorId }).returning(); await this.audit.record({ orgId, actorId, action: "notification_rule.create", subjectType: "notification_rule", subjectId: r!.id, after: v, ip }, tx); return r!; });
  }
  async updateRule(orgId: string, actorId: string, id: string, patch: Partial<RuleIn>, ip: string | null) {
    const [cur] = await this.db.select().from(notificationRule).where(and(eq(notificationRule.id, id), eq(notificationRule.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "rule_not_found" });
    const next: RuleIn = { name: cur.name, eventKind: cur.eventKind as RuleIn["eventKind"], locationIds: cur.locationIds, conditions: cur.conditions as RuleIn["conditions"], recipientUserIds: cur.recipientUserIds, recipientRoles: cur.recipientRoles, channels: cur.channels, quietStart: cur.quietStart, quietEnd: cur.quietEnd, critical: cur.critical, digest: cur.digest, digestAt: cur.digestAt, active: cur.active, ...patch };
    await this.check(orgId, next);
    return this.db.transaction(async (tx) => { const [r] = await tx.update(notificationRule).set(next).where(eq(notificationRule.id, id)).returning(); await this.audit.record({ orgId, actorId, action: "notification_rule.update", subjectType: "notification_rule", subjectId: id, before: { active: cur.active, name: cur.name }, after: patch, ip }, tx); return r!; });
  }
  async log(orgId: string, ruleId?: string) {
    const rows = await this.db.select({ n: notification, who: user.name, email: user.email }).from(notification).innerJoin(user, eq(user.id, notification.userId)).where(and(eq(notification.orgId, orgId), ruleId ? eq(notification.ruleId, ruleId) : undefined)).orderBy(desc(notification.createdAt)).limit(200);
    return rows.map(({ n, who, email }) => ({ id: n.id, ruleId: n.ruleId, to: who, email, kind: n.eventKind, title: n.title, severity: n.severity, status: n.status, emailStatus: n.emailStatus, heldUntil: n.heldUntil, createdAt: n.createdAt, readAt: n.readAt }));
  }

  // ------------------------------------------------------------ the inbox (everyone, their own)
  async inbox(orgId: string, userId: string, o: { unread?: boolean; limit?: number }) {
    const rows = await this.db.select().from(notification).where(and(eq(notification.orgId, orgId), eq(notification.userId, userId), eq(notification.status, "delivered"), o.unread ? sql`${notification.readAt} is null` : undefined)).orderBy(desc(notification.createdAt)).limit(Math.min(o.limit ?? 50, 200));
    const locs = new Map((await this.db.select({ id: location.id, name: location.name }).from(location).where(eq(location.orgId, orgId))).map((l) => [l.id, l.name]));
    return rows.map((n) => ({ id: n.id, kind: n.eventKind, title: n.title, body: n.body, severity: n.severity, location: n.locationId ? locs.get(n.locationId) ?? null : null, locationId: n.locationId, createdAt: n.deliveredAt ?? n.createdAt, readAt: n.readAt }));
  }
  async unread(orgId: string, userId: string) { return { count: (await this.db.select({ n: sql<number>`count(*)::int` }).from(notification).where(and(eq(notification.orgId, orgId), eq(notification.userId, userId), eq(notification.status, "delivered"), sql`${notification.readAt} is null`)))[0]!.n }; }
  async markRead(orgId: string, userId: string, o: { ids?: string[]; all?: boolean }) {
    const rows = await this.db.update(notification).set({ readAt: new Date() }).where(and(eq(notification.orgId, orgId), eq(notification.userId, userId), eq(notification.status, "delivered"), sql`${notification.readAt} is null`, o.all ? undefined : inArray(notification.id, o.ids?.length ? o.ids : ["00000000-0000-0000-0000-000000000000"]))).returning({ id: notification.id });
    return { read: rows.length };
  }
}
