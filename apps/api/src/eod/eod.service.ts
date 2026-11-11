import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { MailService } from "../access/mail.service";
import { AuditService } from "../audit/audit.service";
import { businessDate, isValidTimeZone } from "../common/business-day";
import { DB, type Db } from "../db/db.module";
import { eodReportRun, eodSchedule, location, scheduledJob } from "../db/schema";
import { checksumOf, dueDays, renderCsv, renderLines, subjectOf, totalsOf, type Figures, type LocationFigures, type RunStatus } from "./figures";
import { textPdf } from "./pdf";

type Row = Record<string, unknown>;
export interface ScheduleIn { name: string; locationIds: string[] | null; sendAtLocal: string; daysOfWeek: number[]; timezone: string; methods: string[]; recipients: string[]; webhookUrl: string | null; format: "pdf" | "csv" | "inline"; onlyWhenClosed: boolean; maxWaitMinutes: number; active: boolean }
const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const STALE_MS = 15 * 60_000, AMEND_WINDOW_MS = 48 * 3_600_000;

/** Writes each location's end-of-day figures and sends them on a schedule, in the schedule's own time zone. Jobs are unique per (schedule, business day), so a restarted or doubled worker cannot send twice. */
@Injectable()
export class EodService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null; private logger = new Logger("eod");
  constructor(@Inject(DB) private db: Db, @Inject(MailService) private mail: MailService, @Inject(AuditService) private audit: AuditService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.tick().catch((e) => this.logger.warn(`tick: ${String(e)}`)); }, 60_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ------------------------------------------------------------ schedules
  private async places(orgId: string, s: Pick<typeof eodSchedule.$inferSelect, "locationIds">) {
    return this.db.select().from(location).where(s.locationIds ? and(eq(location.orgId, orgId), inArray(location.id, s.locationIds)) : and(eq(location.orgId, orgId), inArray(location.type, ["store"]))).orderBy(location.name);
  }
  private async check(orgId: string, v: ScheduleIn) {
    if (!isValidTimeZone(v.timezone)) throw new BadRequestException({ code: "bad_timezone" });
    if (v.methods.includes("email") && !v.recipients.length) throw new BadRequestException({ code: "no_recipients" });
    if (v.methods.includes("webhook") && !v.webhookUrl) throw new BadRequestException({ code: "no_webhook_url" });
    if (v.webhookUrl) { let u: URL; try { u = new URL(v.webhookUrl); } catch { throw new BadRequestException({ code: "bad_webhook_url" }); } if (!/^https?:$/.test(u.protocol)) throw new BadRequestException({ code: "bad_webhook_url" }); }
    if (v.locationIds) { if (!v.locationIds.length) throw new BadRequestException({ code: "no_locations" }); const f = await this.db.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, v.locationIds))); if (f.length !== new Set(v.locationIds).size) throw new NotFoundException({ code: "location_not_found" }); }
  }
  async create(orgId: string, actorId: string, v: ScheduleIn, ip: string | null) {
    await this.check(orgId, v); const secret = v.methods.includes("webhook") ? randomBytes(24).toString("hex") : null;
    return this.db.transaction(async (tx) => { const [r] = await tx.insert(eodSchedule).values({ orgId, ...v, webhookSecret: secret, createdBy: actorId }).returning(); await this.audit.record({ orgId, actorId, action: "eod_schedule.create", subjectType: "eod_schedule", subjectId: r!.id, after: { ...v }, ip }, tx); return { ...this.shape(r!), webhookSecret: secret }; });   // the secret is shown once
  }
  async update(orgId: string, actorId: string, id: string, patch: Partial<ScheduleIn>, ip: string | null) {
    const [cur] = await this.db.select().from(eodSchedule).where(and(eq(eodSchedule.id, id), eq(eodSchedule.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "schedule_not_found" });
    const next: ScheduleIn = { name: cur.name, locationIds: cur.locationIds, sendAtLocal: cur.sendAtLocal, daysOfWeek: cur.daysOfWeek, timezone: cur.timezone, methods: cur.methods, recipients: cur.recipients, webhookUrl: cur.webhookUrl, format: cur.format as ScheduleIn["format"], onlyWhenClosed: cur.onlyWhenClosed, maxWaitMinutes: cur.maxWaitMinutes, active: cur.active, ...patch };
    await this.check(orgId, next); const secret = cur.webhookSecret ?? (next.methods.includes("webhook") ? randomBytes(24).toString("hex") : null);
    return this.db.transaction(async (tx) => { const [r] = await tx.update(eodSchedule).set({ ...next, webhookSecret: secret }).where(eq(eodSchedule.id, id)).returning(); await this.audit.record({ orgId, actorId, action: "eod_schedule.update", subjectType: "eod_schedule", subjectId: id, after: patch, ip }, tx); return this.shape(r!); });
  }
  private shape(r: typeof eodSchedule.$inferSelect) { const { webhookSecret, ...rest } = r; return { ...rest, hasWebhookSecret: !!webhookSecret }; }
  async list(orgId: string) {
    const rows = await this.db.select().from(eodSchedule).where(eq(eodSchedule.orgId, orgId)).orderBy(desc(eodSchedule.createdAt));
    const names = new Map((await this.db.select({ id: location.id, name: location.name }).from(location).where(eq(location.orgId, orgId))).map((l) => [l.id, l.name]));
    const last = new Map((await this.db.execute(sql`select distinct on (schedule_id) schedule_id::text as id, local_date::text as d, version, status, generated_at from shelfline.eod_report_run where org_id = ${orgId} order by schedule_id, generated_at desc`)).rows.map((r) => [String(r.id), r as Row]));
    return rows.map((r) => ({ ...this.shape(r), locations: r.locationIds ? r.locationIds.map((i) => names.get(i) ?? "?") : null, last: last.get(r.id) ? { date: last.get(r.id)!.d, version: last.get(r.id)!.version, status: last.get(r.id)!.status, at: last.get(r.id)!.generated_at } : null }));
  }
  async runs(orgId: string, scheduleId?: string) {
    const rows = await this.db.select({ r: eodReportRun, name: eodSchedule.name }).from(eodReportRun).innerJoin(eodSchedule, eq(eodSchedule.id, eodReportRun.scheduleId)).where(and(eq(eodReportRun.orgId, orgId), scheduleId ? eq(eodReportRun.scheduleId, scheduleId) : undefined)).orderBy(desc(eodReportRun.generatedAt)).limit(100);
    return rows.map(({ r, name }) => ({ id: r.id, scheduleId: r.scheduleId, schedule: name, date: String(r.localDate), version: r.version, status: r.status, notes: r.notes, delivered: r.delivered, generatedAt: r.generatedAt, totals: (r.figures as Figures).totals }));
  }
  async runText(orgId: string, id: string) {
    const [x] = await this.db.select({ r: eodReportRun, name: eodSchedule.name }).from(eodReportRun).innerJoin(eodSchedule, eq(eodSchedule.id, eodReportRun.scheduleId)).where(and(eq(eodReportRun.id, id), eq(eodReportRun.orgId, orgId))); if (!x) throw new NotFoundException({ code: "run_not_found" });
    return { lines: renderLines(x.name, x.r.status as RunStatus, x.r.figures as Figures, x.r.notes, x.r.version), csv: renderCsv(x.r.figures as Figures) };
  }

  // ------------------------------------------------------------ figures and conditions
  async figures(orgId: string, locs: { id: string; name: string }[], date: string): Promise<Figures> {
    if (!locs.length) return { localDate: date, locations: [], totals: totalsOf([]) };
    const ids = locs.map((l) => l.id); const inList = idList(ids);
    const sales = (await this.db.execute(sql`select location_id::text as id, count(*)::int as orders, coalesce(sum(total_minor), 0)::int as gross, coalesce(sum(discount_minor), 0)::int as disc, coalesce(sum(tax_minor), 0)::int as tax from shelfline.sale where org_id = ${orgId} and local_date = ${date}::date and location_id in (${inList}) and status in ('completed','partially_refunded','refunded') group by 1`)).rows as Row[];
    const refunds = (await this.db.execute(sql`select location_id::text as id, coalesce(sum(total_minor), 0)::int as amt from shelfline.refund where org_id = ${orgId} and local_date = ${date}::date and location_id in (${inList}) group by 1`)).rows as Row[];
    const tenders = (await this.db.execute(sql`select s.location_id::text as id, p.tender, coalesce(sum(p.amount_minor), 0)::int as amt from shelfline.payment p join shelfline.sale s on s.id = p.sale_id where s.org_id = ${orgId} and s.local_date = ${date}::date and s.location_id in (${inList}) group by 1, 2`)).rows as Row[];
    const noSales = (await this.db.execute(sql`select location_id::text as id, count(*)::int as n from shelfline.cash_movement where org_id = ${orgId} and local_date = ${date}::date and kind = 'no_sale' and location_id in (${inList}) group by 1`)).rows as Row[];
    const ses = (await this.db.execute(sql`select s.location_id::text as id, count(*) filter (where s.status in ('closed','force_closed'))::int as closed, count(*) filter (where s.status = 'open')::int as open, coalesce(sum(s.variance_minor) filter (where s.status in ('closed','force_closed')), 0)::int as variance
      from shelfline.register_session s join shelfline.location l on l.id = s.location_id where s.org_id = ${orgId} and s.location_id in (${inList}) and (case when (s.opened_at at time zone l.timezone)::time >= l.day_cutoff then (s.opened_at at time zone l.timezone)::date else (s.opened_at at time zone l.timezone)::date - 1 end) = ${date}::date group by 1`)).rows as Row[];
    const by = (rows: Row[], id: string) => rows.find((r) => r.id === id); const locations: LocationFigures[] = locs.map((l) => {
      const s = by(sales, l.id), rf = Number(by(refunds, l.id)?.amt ?? 0), se = by(ses, l.id); const gross = Number(s?.gross ?? 0);
      return { id: l.id, name: l.name, orders: Number(s?.orders ?? 0), grossMinor: gross, discountMinor: Number(s?.disc ?? 0), refundsMinor: rf, netMinor: gross - rf, taxMinor: Number(s?.tax ?? 0), tenders: Object.fromEntries(tenders.filter((t) => t.id === l.id).map((t) => [String(t.tender), Number(t.amt)]).sort()), noSales: Number(by(noSales, l.id)?.n ?? 0), sessionsClosed: Number(se?.closed ?? 0), sessionsOpen: Number(se?.open ?? 0), varianceMinor: Number(se?.variance ?? 0) };
    });
    return { localDate: date, locations, totals: totalsOf(locations) };
  }
  /** What stops this from being the final word: registers still open, and tills that still hold unsent sales (or have gone quiet with a register open). */
  async openIssues(orgId: string, ids: string[], now: Date) {
    if (!ids.length) return { open: [] as string[], queued: [] as string[] };
    const open = (await this.db.execute(sql`select distinct rg.name || ' at ' || l.name as n from shelfline.register_session s join shelfline.register rg on rg.id = s.register_id join shelfline.location l on l.id = s.location_id where s.org_id = ${orgId} and s.status = 'open' and s.location_id in (${idList(ids)})`)).rows.map((r) => String(r.n));
    const queued = (await this.db.execute(sql`select distinct d.name || ' at ' || l.name as n from shelfline.device d join shelfline.location l on l.id = d.location_id where d.org_id = ${orgId} and d.kind = 'pos' and d.status = 'active' and d.location_id in (${idList(ids)})
      and (d.queued_count > 0 or (d.register_id is not null and exists (select 1 from shelfline.register_session s where s.register_id = d.register_id and s.status = 'open') and (d.last_seen_at is null or d.last_seen_at < ${new Date(now.getTime() - STALE_MS).toISOString()}::timestamptz)))`)).rows.map((r) => String(r.n));
    return { open, queued };
  }

  // ------------------------------------------------------------ the worker
  /** Creates the day's job when its time has come, runs due jobs, then looks again at recent reports for changes. Safe to call from several workers at once and to call repeatedly. */
  async tick(now = new Date()) {
    const schedules = await this.db.select().from(eodSchedule).where(eq(eodSchedule.active, true));
    for (const sc of schedules) {
      const places = await this.places(sc.orgId, sc); const cutoff = String((await this.db.select({ c: sql<string>`${location.dayCutoff}::text` }).from(location).where(eq(location.id, places[0]?.id ?? sc.id)))[0]?.c ?? "04:00:00").slice(0, 5);
      for (const d of dueDays({ sendAtLocal: sc.sendAtLocal, daysOfWeek: sc.daysOfWeek, timezone: sc.timezone, cutoff }, now)) {
        if (d.runAt.getTime() < sc.createdAt.getTime()) continue;            // a schedule made after a day's send time does not report on it
        await this.db.insert(scheduledJob).values({ orgId: sc.orgId, kind: "eod", scheduleId: sc.id, localDate: d.reportDate, runAt: d.runAt }).onConflictDoNothing();
      }
    }
    const due = await this.db.select().from(scheduledJob).where(and(eq(scheduledJob.kind, "eod"), inArray(scheduledJob.status, ["pending", "waiting"]), sql`${scheduledJob.runAt} <= ${now.toISOString()}::timestamptz`));
    let ran = 0;
    for (const j of due) {
      // claim it: only one worker moves it from pending/waiting to running
      const [claimed] = await this.db.update(scheduledJob).set({ status: "running", attempts: sql`${scheduledJob.attempts} + 1`, updatedAt: now }).where(and(eq(scheduledJob.id, j.id), inArray(scheduledJob.status, ["pending", "waiting"]))).returning();
      if (!claimed) continue;
      try { const r = await this.runJob(claimed, now); await this.db.update(scheduledJob).set({ status: r, lastError: null, updatedAt: new Date() }).where(eq(scheduledJob.id, j.id)); if (r === "done") ran++; }
      catch (e) { await this.db.update(scheduledJob).set({ status: claimed.attempts >= 5 ? "cancelled" : "pending", lastError: String(e).slice(0, 300), updatedAt: new Date() }).where(eq(scheduledJob.id, j.id)); this.logger.warn(`eod job ${j.id}: ${String(e)}`); }
    }
    const amended = await this.amend(now);
    return { ran, amended };
  }

  private async runJob(j: typeof scheduledJob.$inferSelect, now: Date): Promise<"done" | "waiting" | "cancelled"> {
    const [sc] = await this.db.select().from(eodSchedule).where(eq(eodSchedule.id, j.scheduleId)); if (!sc || !sc.active) return "cancelled";
    const places = await this.places(sc.orgId, sc); const issues = await this.openIssues(sc.orgId, places.map((p) => p.id), now);
    const date = String(j.localDate);
    if (sc.onlyWhenClosed && issues.open.length && now.getTime() < j.runAt.getTime() + sc.maxWaitMinutes * 60_000) return "waiting";
    const f = await this.figures(sc.orgId, places, date); const notes = this.notesFor(issues, sc.onlyWhenClosed && issues.open.length > 0);
    const status: RunStatus = issues.open.length || issues.queued.length ? "provisional" : "final";
    await this.record(sc, date, 1, status, f, notes, now);
    return "done";
  }
  private notesFor(i: { open: string[]; queued: string[] }, gaveUp: boolean) {
    return [...(i.open.length ? [`${gaveUp ? "Still open after waiting: " : "Still open: "}${i.open.join(", ")}`] : []), ...(i.queued.length ? [`Not yet fully synced: ${i.queued.join(", ")}`] : [])];
  }
  private async record(sc: typeof eodSchedule.$inferSelect, date: string, version: number, status: RunStatus, f: Figures, notes: string[], now: Date) {
    const [run] = await this.db.insert(eodReportRun).values({ orgId: sc.orgId, scheduleId: sc.id, localDate: date, version, status, figures: f as never, checksum: checksumOf(f), notes, generatedAt: now }).onConflictDoNothing().returning();
    if (!run) return null; const delivered = await this.deliver(sc, run, f); return { run, delivered };
  }

  /** After the first report, keep comparing the day with what was sent for up to 48 hours: changed figures make a new, labelled version; unchanged figures just settle a provisional one into final. */
  async amend(now: Date) {
    const jobs = await this.db.select().from(scheduledJob).where(and(eq(scheduledJob.kind, "eod"), eq(scheduledJob.status, "done"), sql`${scheduledJob.runAt} > ${new Date(now.getTime() - AMEND_WINDOW_MS).toISOString()}::timestamptz`)); let n = 0;
    for (const j of jobs) {
      const [sc] = await this.db.select().from(eodSchedule).where(eq(eodSchedule.id, j.scheduleId)); if (!sc) continue; const date = String(j.localDate);
      const [last] = await this.db.select().from(eodReportRun).where(and(eq(eodReportRun.scheduleId, sc.id), eq(eodReportRun.localDate, date))).orderBy(desc(eodReportRun.version)).limit(1); if (!last) continue;
      const places = await this.places(sc.orgId, sc); const f = await this.figures(sc.orgId, places, date); const issues = await this.openIssues(sc.orgId, places.map((p) => p.id), now); const clear = !issues.open.length && !issues.queued.length;
      if (checksumOf(f) !== last.checksum) { const r = await this.record(sc, date, last.version + 1, "amended", f, [`Changed since version ${last.version}.`, ...this.notesFor(issues, false)], now); if (r) n++; }
      else if (last.status === "provisional" && clear) await this.db.execute(sql`select shelfline.eod_settle(${last.id}::uuid)`);
    }
    return n;
  }

  // ------------------------------------------------------------ delivery
  private async deliver(sc: typeof eodSchedule.$inferSelect, run: typeof eodReportRun.$inferSelect, f: Figures) {
    const status = run.status as RunStatus; const lines = renderLines(sc.name, status, f, run.notes, run.version); const subject = subjectOf(status, sc.name, String(run.localDate));
    const attachment = sc.format === "pdf" ? { name: `end-of-day-${run.localDate}-v${run.version}.pdf`, type: "application/pdf", base64: textPdf(subject, lines).toString("base64") } : sc.format === "csv" ? { name: `end-of-day-${run.localDate}-v${run.version}.csv`, type: "text/csv", base64: Buffer.from(renderCsv(f)).toString("base64") } : undefined;
    const out: { method: string; to: string; at: string; ok: boolean; detail?: string }[] = [];
    if (sc.methods.includes("email")) for (const to of sc.recipients) { await this.mail.send(sc.orgId, { to, subject, body: lines.join("\n"), kind: "eod_report", attachment }); out.push({ method: "email", to, at: new Date().toISOString(), ok: true }); }
    if (sc.methods.includes("webhook") && sc.webhookUrl) {
      const body = JSON.stringify({ schedule: sc.name, localDate: String(run.localDate), version: run.version, status, notes: run.notes, figures: f }); const ts = String(Math.floor(Date.now() / 1000));
      try { const res = await fetch(sc.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-shelfline-timestamp": ts, "x-shelfline-signature": createHmac("sha256", sc.webhookSecret ?? "").update(`${ts}.${body}`).digest("hex") }, body, signal: AbortSignal.timeout(5000) }); out.push({ method: "webhook", to: sc.webhookUrl, at: new Date().toISOString(), ok: res.ok, detail: `HTTP ${res.status}` }); }
      catch (e) { out.push({ method: "webhook", to: sc.webhookUrl, at: new Date().toISOString(), ok: false, detail: String(e).slice(0, 120) }); }
    }
    await this.db.execute(sql`select shelfline.eod_delivered(${run.id}::uuid, ${JSON.stringify(out)}::jsonb)`);
    return out;
  }

  /** "Send a test now": makes the report for the latest finished business day, whatever the clock says, and always as a new version. */
  async sendNow(orgId: string, actorId: string, scheduleId: string, date: string | undefined, now = new Date(), ip: string | null = null) {
    const [sc] = await this.db.select().from(eodSchedule).where(and(eq(eodSchedule.id, scheduleId), eq(eodSchedule.orgId, orgId))); if (!sc) throw new NotFoundException({ code: "schedule_not_found" });
    const places = await this.places(orgId, sc); const d = date ?? businessDate(now, sc.timezone, String(places[0]?.dayCutoff ?? "04:00").slice(0, 5));      // the trading day in progress, not the calendar day
    const [last] = await this.db.select({ v: eodReportRun.version }).from(eodReportRun).where(and(eq(eodReportRun.scheduleId, sc.id), eq(eodReportRun.localDate, d))).orderBy(desc(eodReportRun.version)).limit(1);
    const issues = await this.openIssues(orgId, places.map((p) => p.id), now); const f = await this.figures(orgId, places, d);
    const r = await this.record(sc, d, (last?.v ?? 0) + 1, issues.open.length || issues.queued.length ? "provisional" : last ? "amended" : "final", f, ["Sent on request.", ...this.notesFor(issues, false)], now); if (!r) throw new ConflictException({ code: "version_exists" });
    await this.audit.record({ orgId, actorId, action: "eod_schedule.send_now", subjectType: "eod_schedule", subjectId: sc.id, detail: { date: d, version: r.run.version }, ip });
    return { runId: r.run.id, version: r.run.version, status: r.run.status, delivered: r.delivered };
  }
}
