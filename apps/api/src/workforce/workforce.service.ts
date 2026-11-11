import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { businessDate, zonedInstant } from "../common/business-day";
import { DB, type Db } from "../db/db.module";
import { location, punch, shift, shiftTemplate, staffingNeed, timesheetEntry, user, userAssignment } from "../db/schema";
import { computeEntry, pairPunches } from "./pairing";

type Perm = "roster:read" | "roster:write" | "timesheet:read" | "timesheet:approve";
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
const hm = /^[0-2]\d:[0-5]\d$/;
export interface ShiftIn { locationId: string; userId?: string | null; date: string; start: string; end: string; role?: string | null; breakMinutes?: number; note?: string | null }

@Injectable()
export class WorkforceService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}
  private async need(userId: string, perm: Perm, locationId: string) { if (!(await this.authz.can(userId, perm, locationId))) throw new ForbiddenException({ code: "forbidden", permission: perm, locationId }); }
  private async loc(orgId: string, id: string) { const [l] = await this.db.select().from(location).where(and(eq(location.id, id), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" }); return l; }

  // ------------------------------------------------------------ shifts
  private span(l: { timezone: string }, v: { date: string; start: string; end: string }) {
    if (!hm.test(v.start) || !hm.test(v.end) || v.start === v.end) throw new BadRequestException({ code: "bad_times" });
    const startsAt = new Date(zonedInstant(v.date, v.start, l.timezone)); const endsAt = new Date(zonedInstant(v.end > v.start ? v.date : addDays(v.date, 1), v.end, l.timezone));
    if (endsAt <= startsAt) throw new BadRequestException({ code: "bad_times" }); return { startsAt, endsAt };
  }
  private async assertPerson(tx: Pick<Db, "select">, orgId: string, userId: string, locationId: string) {
    const [u] = await tx.select({ id: user.id, status: user.status }).from(user).where(and(eq(user.id, userId), eq(user.orgId, orgId))); if (!u || u.status !== "active") throw new NotFoundException({ code: "user_not_found" });
    const a = await tx.select({ l: userAssignment.locationId }).from(userAssignment).where(eq(userAssignment.userId, userId)); if (!a.some((x) => x.l === null || x.l === locationId)) throw new BadRequestException({ code: "user_not_assigned" });
  }
  private async clash(tx: Pick<Db, "select">, userId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
    const r = await tx.select({ id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt }).from(shift).where(and(eq(shift.userId, userId), lt(shift.startsAt, endsAt), sql`${shift.endsAt} > ${startsAt}`, exceptId ? sql`${shift.id} <> ${exceptId}` : undefined)).limit(1);
    if (r[0]) throw new ConflictException({ code: "shift_overlap", conflictId: r[0].id });
  }
  async createShift(orgId: string, actorId: string, v: ShiftIn, ip: string | null) {
    await this.need(actorId, "roster:write", v.locationId); const l = await this.loc(orgId, v.locationId); const { startsAt, endsAt } = this.span(l, v);
    return this.db.transaction(async (tx) => {
      if (v.userId) { await this.assertPerson(tx, orgId, v.userId, v.locationId); await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${v.userId}, 1))`); await this.clash(tx, v.userId, startsAt, endsAt); }
      const [s] = await tx.insert(shift).values({ orgId, locationId: v.locationId, userId: v.userId ?? null, localDate: v.date, startsAt, endsAt, role: v.role ?? null, breakMinutes: v.breakMinutes ?? 0, note: v.note ?? null, createdBy: actorId }).returning();
      await this.audit.record({ orgId, actorId, action: "shift.create", subjectType: "shift", subjectId: s!.id, after: { ...v, startsAt, endsAt }, ip }, tx); return s!;
    });
  }
  async updateShift(orgId: string, actorId: string, id: string, v: Partial<Omit<ShiftIn, "locationId">>, ip: string | null) {
    const [cur] = await this.db.select().from(shift).where(and(eq(shift.id, id), eq(shift.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "shift_not_found" });
    await this.need(actorId, "roster:write", cur.locationId); const l = await this.loc(orgId, cur.locationId);
    const date = v.date ?? cur.localDate; const wall = (d: Date) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: l.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(d); return p; };
    const { startsAt, endsAt } = this.span(l, { date: String(date), start: v.start ?? wall(cur.startsAt), end: v.end ?? wall(cur.endsAt) });
    const userId = "userId" in v ? v.userId ?? null : cur.userId;
    return this.db.transaction(async (tx) => {
      if (userId) { await this.assertPerson(tx, orgId, userId, cur.locationId); await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`); await this.clash(tx, userId, startsAt, endsAt, id); }
      const [s] = await tx.update(shift).set({ userId, localDate: String(date), startsAt, endsAt, ...("role" in v ? { role: v.role ?? null } : {}), ...(v.breakMinutes !== undefined ? { breakMinutes: v.breakMinutes } : {}), ...("note" in v ? { note: v.note ?? null } : {}) }).where(eq(shift.id, id)).returning();
      await this.audit.record({ orgId, actorId, action: "shift.update", subjectType: "shift", subjectId: id, before: { userId: cur.userId, startsAt: cur.startsAt, endsAt: cur.endsAt }, after: v, ip }, tx); return s!;
    });
  }
  async deleteShift(orgId: string, actorId: string, id: string, ip: string | null) {
    const [cur] = await this.db.select().from(shift).where(and(eq(shift.id, id), eq(shift.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "shift_not_found" }); await this.need(actorId, "roster:write", cur.locationId);
    await this.db.transaction(async (tx) => { await tx.delete(shift).where(eq(shift.id, id)); await this.audit.record({ orgId, actorId, action: "shift.delete", subjectType: "shift", subjectId: id, before: { userId: cur.userId, startsAt: cur.startsAt, endsAt: cur.endsAt, published: !!cur.publishedAt }, ip }, tx); });
  }
  async publish(orgId: string, actorId: string, v: { locationId: string; from: string; to: string }, ip: string | null) {
    await this.need(actorId, "roster:write", v.locationId);
    return this.db.transaction(async (tx) => {
      const r = await tx.update(shift).set({ publishedAt: new Date() }).where(and(eq(shift.orgId, orgId), eq(shift.locationId, v.locationId), gte(shift.localDate, v.from), lte(shift.localDate, v.to), isNull(shift.publishedAt))).returning({ id: shift.id });
      await this.audit.record({ orgId, actorId, action: "shift.publish", subjectType: "location", subjectId: v.locationId, after: { from: v.from, to: v.to, shifts: r.length }, ip }, tx); return { published: r.length };
    });
  }
  async list(orgId: string, userId: string, o: { locationId: string; from: string; to: string; userId?: string }) {
    await this.need(userId, "roster:read", o.locationId);
    const rows = await this.db.select({ s: shift, name: user.name }).from(shift).leftJoin(user, eq(user.id, shift.userId)).where(and(eq(shift.orgId, orgId), eq(shift.locationId, o.locationId), gte(shift.localDate, o.from), lte(shift.localDate, o.to), o.userId ? eq(shift.userId, o.userId) : undefined)).orderBy(asc(shift.startsAt));
    const needs = await this.db.select().from(staffingNeed).where(eq(staffingNeed.locationId, o.locationId)); const need = new Map(needs.map((n) => [n.weekday, n.minStaff]));
    const days: { date: string; weekday: number; need: number; staffed: number; open: number; under: boolean }[] = [];
    for (let d = o.from; d <= o.to && days.length < 62; d = addDays(d, 1)) { const todays = rows.filter((r) => String(r.s.localDate) === d); const staffed = new Set(todays.filter((r) => r.s.userId).map((r) => r.s.userId)).size; const n = need.get(weekday(d)) ?? 0; days.push({ date: d, weekday: weekday(d), need: n, staffed, open: todays.filter((r) => !r.s.userId).length, under: staffed < n }); }
    const conflicts = new Set<string>(); const byUser = new Map<string, typeof rows>(); for (const r of rows) if (r.s.userId) (byUser.get(r.s.userId) ?? byUser.set(r.s.userId, []).get(r.s.userId)!).push(r);
    for (const list of byUser.values()) for (let i = 1; i < list.length; i++) if (list[i]!.s.startsAt < list[i - 1]!.s.endsAt) { conflicts.add(list[i]!.s.id); conflicts.add(list[i - 1]!.s.id); }
    return { shifts: rows.map((r) => ({ id: r.s.id, userId: r.s.userId, user: r.name, date: String(r.s.localDate), startsAt: r.s.startsAt, endsAt: r.s.endsAt, role: r.s.role, breakMinutes: r.s.breakMinutes, note: r.s.note, published: !!r.s.publishedAt, conflict: conflicts.has(r.s.id) })), days };
  }
  async mine(orgId: string, userId: string, o: { from: string; to: string }) {
    const rows = await this.db.select({ s: shift, loc: location.name, tz: location.timezone }).from(shift).innerJoin(location, eq(location.id, shift.locationId)).where(and(eq(shift.orgId, orgId), eq(shift.userId, userId), gte(shift.localDate, o.from), lte(shift.localDate, o.to), sql`${shift.publishedAt} is not null`)).orderBy(asc(shift.startsAt));
    return rows.map((r) => ({ id: r.s.id, date: String(r.s.localDate), startsAt: r.s.startsAt, endsAt: r.s.endsAt, role: r.s.role, breakMinutes: r.s.breakMinutes, location: r.loc, timezone: r.tz }));
  }

  // ------------------------------------------------------------ templates and staffing need
  async templates(orgId: string) { return this.db.select().from(shiftTemplate).where(eq(shiftTemplate.orgId, orgId)).orderBy(asc(shiftTemplate.startTime)); }
  async createTemplate(orgId: string, actorId: string, v: { name: string; startTime: string; endTime: string; role?: string | null; breakMinutes?: number; locationId?: string | null }, ip: string | null) {
    if (!hm.test(v.startTime) || !hm.test(v.endTime) || v.startTime === v.endTime) throw new BadRequestException({ code: "bad_times" });
    try { return await this.db.transaction(async (tx) => { const [t] = await tx.insert(shiftTemplate).values({ orgId, ...v, role: v.role ?? null, breakMinutes: v.breakMinutes ?? 0, locationId: v.locationId ?? null }).returning(); await this.audit.record({ orgId, actorId, action: "shift_template.create", subjectType: "shift_template", subjectId: t!.id, after: v, ip }, tx); return t!; }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "name_taken" }); throw e; }
  }
  async applyTemplate(orgId: string, actorId: string, v: { locationId: string; templateId: string; dates: string[]; userIds: string[] }, ip: string | null) {
    const [t] = await this.db.select().from(shiftTemplate).where(and(eq(shiftTemplate.id, v.templateId), eq(shiftTemplate.orgId, orgId))); if (!t) throw new NotFoundException({ code: "template_not_found" });
    const created: string[] = []; const skipped: { date: string; userId: string | null; reason: string }[] = [];
    for (const date of v.dates) for (const uid of v.userIds.length ? v.userIds : [null]) {
      try { created.push((await this.createShift(orgId, actorId, { locationId: v.locationId, userId: uid, date, start: t.startTime, end: t.endTime, role: t.role, breakMinutes: t.breakMinutes }, ip)).id); }
      catch (e: any) { if (e instanceof ConflictException || e instanceof BadRequestException) skipped.push({ date, userId: uid, reason: (e.getResponse() as { code: string }).code }); else throw e; }
    }
    return { created: created.length, skipped };
  }
  async staffing(orgId: string, locationId: string) { await this.loc(orgId, locationId); const r = await this.db.select().from(staffingNeed).where(eq(staffingNeed.locationId, locationId)); return Object.fromEntries(r.map((x) => [x.weekday, x.minStaff])) as Record<number, number>; }
  async setStaffing(orgId: string, actorId: string, locationId: string, v: Record<string, number>, ip: string | null) {
    await this.need(actorId, "roster:write", locationId); await this.loc(orgId, locationId);
    return this.db.transaction(async (tx) => { await tx.delete(staffingNeed).where(eq(staffingNeed.locationId, locationId)); const rows = Object.entries(v).filter(([, n]) => n > 0).map(([d, n]) => ({ locationId, weekday: Number(d), minStaff: n })); if (rows.length) await tx.insert(staffingNeed).values(rows); await this.audit.record({ orgId, actorId, action: "staffing.set", subjectType: "location", subjectId: locationId, after: v, ip }, tx); return v; });
  }

  // ------------------------------------------------------------ timesheets
  /** Punches nobody has superseded: the facts as they currently stand. The original rows are never touched. */
  private async effectivePunches(orgId: string, locationId: string, from: Date, to: Date, userId?: string) {
    return this.db.execute(sql`select p.id, p.user_id, p.kind, p.client_ts, p.method, p.status, p.supersedes_id from shelfline.punch p
      where p.org_id = ${orgId} and p.location_id = ${locationId} and p.client_ts >= ${from} and p.client_ts < ${to} ${userId ? sql`and p.user_id = ${userId}` : sql``}
        and not exists (select 1 from shelfline.punch q where q.supersedes_id = p.id) order by p.client_ts`).then((r) => r.rows as { id: string; user_id: string; kind: "in" | "out"; client_ts: Date; method: string; status: string; supersedes_id: string | null }[]);
  }
  /** Rebuild the open entries of a place for a date range from the punches and published shifts; approved entries are frozen and left alone. */
  async sync(orgId: string, locationId: string, from: string, to: string, userId?: string, nowMs = Date.now()) {
    const l = await this.loc(orgId, locationId); const lo = new Date(zonedInstant(addDays(from, -1), "00:00", l.timezone)); const hi = new Date(zonedInstant(addDays(to, 2), "00:00", l.timezone));
    const punches = await this.effectivePunches(orgId, locationId, lo, hi, userId); const byUser = new Map<string, typeof punches>(); for (const p of punches) (byUser.get(p.user_id) ?? byUser.set(p.user_id, []).get(p.user_id)!).push(p);
    const shifts = await this.db.select().from(shift).where(and(eq(shift.orgId, orgId), eq(shift.locationId, locationId), gte(shift.startsAt, lo), lt(shift.startsAt, hi), sql`${shift.publishedAt} is not null`));
    const existing = await this.db.select().from(timesheetEntry).where(and(eq(timesheetEntry.orgId, orgId), eq(timesheetEntry.locationId, locationId), gte(timesheetEntry.localDate, from), lte(timesheetEntry.localDate, to), userId ? eq(timesheetEntry.userId, userId) : undefined));
    const keep = new Set<string>();
    await this.db.transaction(async (tx) => {
      for (const [uid, ps] of byUser) {
        const { pairs } = pairPunches(ps.map((p) => ({ id: p.id, kind: p.kind, at: new Date(p.client_ts).getTime() })), nowMs); const mine = shifts.filter((s) => s.userId === uid).map((s) => ({ id: s.id, startsAt: s.startsAt.getTime(), endsAt: s.endsAt.getTime(), breakMinutes: s.breakMinutes }));
        for (const pr of pairs) {
          const c = computeEntry(pr, mine, l); if (c.localDate < from || c.localDate > to) continue; keep.add(`${uid}:${pr.inId}`);
          const row = { orgId, userId: uid, locationId, localDate: c.localDate, punchInId: pr.inId, punchOutId: pr.outId, shiftId: c.shiftId, inAt: new Date(pr.inAt), outAt: pr.outAt === null ? null : new Date(pr.outAt), breakMinutes: c.breakMinutes, workedMinutes: c.workedMinutes, scheduledMinutes: c.scheduledMinutes, lateMinutes: c.lateMinutes, varianceMinutes: c.varianceMinutes, flags: c.flags };
          const was = existing.find((e) => e.userId === uid && e.punchInId === pr.inId); if (was?.status === "approved") continue;
          await tx.insert(timesheetEntry).values(row).onConflictDoUpdate({ target: [timesheetEntry.userId, timesheetEntry.punchInId], set: { ...row, status: "open" }, setWhere: sql`${timesheetEntry.status} = 'open'` });
        }
      }
      const stale = existing.filter((e) => e.status === "open" && !keep.has(`${e.userId}:${e.punchInId}`)).map((e) => e.id); if (stale.length) await tx.delete(timesheetEntry).where(inArray(timesheetEntry.id, stale));
    });
  }
  async timesheets(orgId: string, actorId: string, o: { locationId: string; from: string; to: string; userId?: string }) {
    await this.need(actorId, "timesheet:read", o.locationId); await this.sync(orgId, o.locationId, o.from, o.to, o.userId);
    const rows = await this.db.select({ e: timesheetEntry, name: user.name }).from(timesheetEntry).innerJoin(user, eq(user.id, timesheetEntry.userId)).where(and(eq(timesheetEntry.orgId, orgId), eq(timesheetEntry.locationId, o.locationId), gte(timesheetEntry.localDate, o.from), lte(timesheetEntry.localDate, o.to), o.userId ? eq(timesheetEntry.userId, o.userId) : undefined)).orderBy(asc(timesheetEntry.localDate), asc(timesheetEntry.inAt));
    const entries = rows.map((r) => ({ id: r.e.id, userId: r.e.userId, user: r.name, date: String(r.e.localDate), inAt: r.e.inAt, outAt: r.e.outAt, breakMinutes: r.e.breakMinutes, workedMinutes: r.e.workedMinutes, scheduledMinutes: r.e.scheduledMinutes, lateMinutes: r.e.lateMinutes, varianceMinutes: r.e.varianceMinutes, flags: r.e.flags, status: r.e.status, punchInId: r.e.punchInId, punchOutId: r.e.punchOutId, shiftId: r.e.shiftId }));
    const per = new Map<string, { userId: string; user: string; workedMinutes: number; scheduledMinutes: number; lateMinutes: number; entries: number; problems: number }>();
    for (const e of entries) { const p = per.get(e.userId) ?? { userId: e.userId, user: e.user, workedMinutes: 0, scheduledMinutes: 0, lateMinutes: 0, entries: 0, problems: 0 }; p.workedMinutes += e.workedMinutes ?? 0; p.scheduledMinutes += e.scheduledMinutes ?? 0; p.lateMinutes += e.lateMinutes; p.entries++; if (e.flags.some((f: string) => f === "missing_out")) p.problems++; per.set(e.userId, p); }
    const needsReview = (await this.db.select({ n: sql<number>`count(*)::int` }).from(punch).where(and(eq(punch.orgId, orgId), eq(punch.locationId, o.locationId), eq(punch.status, "needs_review"), gte(punch.clientTs, new Date(zonedInstant(o.from, "00:00", (await this.loc(orgId, o.locationId)).timezone))), sql`not exists (select 1 from shelfline.punch q where q.supersedes_id = ${punch.id})`)))[0]!.n;
    return { entries, people: [...per.values()], needsReviewPunches: needsReview };
  }
  /** A correction is a NEW punch (method "manual") that supersedes the wrong one, or simply adds a missing one. Nothing is overwritten; both stay in the record. */
  async correct(orgId: string, actorId: string, v: { userId: string; locationId: string; kind: "in" | "out"; at: string; supersedesPunchId?: string | null; reason: string }, ip: string | null) {
    await this.need(actorId, "timesheet:approve", v.locationId); const l = await this.loc(orgId, v.locationId); await this.assertPerson(this.db, orgId, v.userId, v.locationId);
    const at = new Date(v.at); if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000) throw new BadRequestException({ code: "bad_time" });
    return this.db.transaction(async (tx) => {
      let old: typeof punch.$inferSelect | undefined;
      if (v.supersedesPunchId) { [old] = await tx.select().from(punch).where(and(eq(punch.id, v.supersedesPunchId), eq(punch.orgId, orgId), eq(punch.userId, v.userId), eq(punch.locationId, v.locationId))); if (!old) throw new NotFoundException({ code: "punch_not_found" });
        const [done] = await tx.select({ id: punch.id }).from(punch).where(eq(punch.supersedesId, old.id)); if (done) throw new ConflictException({ code: "punch_already_corrected" }); }
      for (const d of [businessDate(at, l.timezone, l.dayCutoff), ...(old ? [businessDate(old.clientTs, l.timezone, l.dayCutoff)] : [])]) {
        const [frozen] = await tx.select({ id: timesheetEntry.id }).from(timesheetEntry).where(and(eq(timesheetEntry.userId, v.userId), eq(timesheetEntry.locationId, v.locationId), eq(timesheetEntry.localDate, d), eq(timesheetEntry.status, "approved"))).limit(1);
        if (frozen) throw new ConflictException({ code: "day_approved", date: d });
      }
      const id = crypto.randomUUID();
      await tx.insert(punch).values({ id, orgId, userId: v.userId, locationId: v.locationId, kind: v.kind, method: "manual", sourceDeviceId: null, clientTs: at, status: "accepted", supersedesId: old?.id ?? null });
      await this.audit.record({ orgId, actorId, action: "punch.correct", subjectType: "punch", subjectId: id, before: old ? { id: old.id, kind: old.kind, at: old.clientTs } : null, after: { userId: v.userId, kind: v.kind, at: at.toISOString(), supersedes: old?.id ?? null }, detail: { reason: v.reason }, ip }, tx);
      return { punchId: id };
    });
  }
  async approve(orgId: string, actorId: string, ids: string[], ip: string | null) {
    const rows = await this.db.select().from(timesheetEntry).where(and(eq(timesheetEntry.orgId, orgId), inArray(timesheetEntry.id, ids))); const out: { id: string; result: "approved" | "incomplete" | "already" | "forbidden" | "not_found" }[] = [];
    for (const id of ids) {
      const e = rows.find((r) => r.id === id); if (!e) { out.push({ id, result: "not_found" }); continue; }
      if (!(await this.authz.can(actorId, "timesheet:approve", e.locationId))) { out.push({ id, result: "forbidden" }); continue; }
      if (e.status === "approved") { out.push({ id, result: "already" }); continue; }
      if (e.outAt === null) { out.push({ id, result: "incomplete" }); continue; }
      await this.db.transaction(async (tx) => { await tx.update(timesheetEntry).set({ status: "approved", approvedBy: actorId, approvedAt: new Date() }).where(eq(timesheetEntry.id, id)); await this.audit.record({ orgId, actorId, action: "timesheet.approve", subjectType: "timesheet_entry", subjectId: id, after: { userId: e.userId, workedMinutes: e.workedMinutes, date: e.localDate }, ip }, tx); });
      out.push({ id, result: "approved" });
    }
    return out;
  }
  async minePunches(orgId: string, userId: string, o: { from: string; to: string; locationId: string }) {
    await this.sync(orgId, o.locationId, o.from, o.to, userId);
    return (await this.db.select().from(timesheetEntry).where(and(eq(timesheetEntry.orgId, orgId), eq(timesheetEntry.userId, userId), eq(timesheetEntry.locationId, o.locationId), gte(timesheetEntry.localDate, o.from), lte(timesheetEntry.localDate, o.to))).orderBy(asc(timesheetEntry.inAt)))
      .map((e) => ({ id: e.id, date: String(e.localDate), inAt: e.inAt, outAt: e.outAt, workedMinutes: e.workedMinutes, lateMinutes: e.lateMinutes, flags: e.flags, status: e.status }));
  }
}
