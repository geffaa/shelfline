import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { taxFromInclusive } from "@shelfline/money";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { category, commissionEntry, commissionPeriod, commissionRule, commissionRuleSet, commissionStatement, location, product, taxRate, user, variant } from "../db/schema";
import { WorkforceService } from "../workforce/workforce.service";
import { baseOf, clawbacks, commissionOf, pickRule, recipients, split, type Basis, type RuleSet, type RuleVersion, type ScopeKind, type SplitMode } from "./engine";

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const money = (n: number) => (n / 100).toFixed(2);
const csvCell = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export interface RuleIn { scopeKind: ScopeKind; scopeValue?: string | null; validFrom: string; enabled: boolean; basis: Basis; rateBp: number; splitMode: SplitMode; weights: Record<string, number>; note?: string }
type Row = Record<string, unknown>;

@Injectable()
export class CommissionService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService, @Inject(WorkforceService) private workforce: WorkforceService) {}

  // ------------------------------------------------------------ rules
  private async loadSets(orgId: string, db: Pick<Db, "select"> = this.db): Promise<RuleSet[]> {
    const sets = await db.select().from(commissionRuleSet).where(eq(commissionRuleSet.orgId, orgId));
    const vers = sets.length ? await db.select().from(commissionRule).where(inArray(commissionRule.ruleSetId, sets.map((s) => s.id))) : [];
    return sets.map((s) => ({ id: s.id, scopeKind: s.scopeKind as ScopeKind, scopeValue: s.scopeValue, versions: vers.filter((v) => v.ruleSetId === s.id).sort((a, b) => a.version - b.version).map((v) => ({ id: v.id, version: v.version, validFrom: String(v.validFrom), enabled: v.enabled, basis: v.basis as Basis, rateBp: v.rateBp, splitMode: v.splitMode as SplitMode, weights: v.weights as Record<string, number> })) }));
  }

  async listRules(orgId: string) {
    const sets = await this.db.select().from(commissionRuleSet).where(eq(commissionRuleSet.orgId, orgId)); const all = await this.loadSets(orgId);
    const places = await this.db.select({ id: location.id, name: location.name, tz: location.timezone }).from(location).where(eq(location.orgId, orgId)); const locs = new Map(places.map((l) => [l.id, l.name]));
    const cats = new Map((await this.db.select({ id: category.id, name: category.name }).from(category).where(eq(category.orgId, orgId))).map((c) => [c.id, c.name]));
    const vars = new Map((await this.db.select({ id: variant.id, sku: variant.sku, title: product.title }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(eq(variant.orgId, orgId))).map((v) => [v.id, `${v.title} · ${v.sku}`]));
    // "today" for a rule is the latest calendar day anywhere the business trades, so a rule starting at dawn in Melbourne already shows as in force
    const today = places.map((l) => new Intl.DateTimeFormat("en-CA", { timeZone: l.tz }).format(new Date())).reduce((a, b) => (a > b ? a : b), new Date().toISOString().slice(0, 10));
    return sets.map((s) => { const set = all.find((x) => x.id === s.id)!; const inForce = set.versions.filter((v) => v.validFrom <= today).at(-1) ?? null;
      const label = s.scopeKind === "default" ? "Everything else" : s.scopeKind === "location" ? locs.get(s.scopeValue!) ?? "Unknown location" : s.scopeKind === "category" ? cats.get(s.scopeValue!) ?? "Unknown category" : s.scopeKind === "brand" ? s.scopeValue! : vars.get(s.scopeValue!) ?? "Unknown variant";
      return { id: s.id, name: s.name, scopeKind: s.scopeKind, scopeValue: s.scopeValue, label, inForceId: inForce?.id ?? null, versions: [...set.versions].reverse() }; })
      .sort((a, b) => ["variant", "brand", "category", "location", "default"].indexOf(a.scopeKind) - ["variant", "brand", "category", "location", "default"].indexOf(b.scopeKind) || a.label.localeCompare(b.label));
  }

  /** Adds a version to the rule for a scope (creating the scope the first time). Versions are never edited; history is what lets old sales keep their old rate. */
  async addVersion(orgId: string, actorId: string, v: RuleIn, ip: string | null) {
    if (!isDate(v.validFrom)) throw new BadRequestException({ code: "bad_date" });
    let value = v.scopeKind === "default" ? null : (v.scopeValue ?? "").trim();
    if (v.scopeKind !== "default" && !value) throw new BadRequestException({ code: "scope_value_required" });
    if (v.scopeKind === "brand") value = value!.toLowerCase();
    let label = "Everything else";
    if (v.scopeKind === "location") { const [l] = await this.db.select({ n: location.name }).from(location).where(and(eq(location.id, value!), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "scope_not_found" }); label = l.n; }
    if (v.scopeKind === "category") { const [c] = await this.db.select({ n: category.name }).from(category).where(and(eq(category.id, value!), eq(category.orgId, orgId))); if (!c) throw new NotFoundException({ code: "scope_not_found" }); label = c.n; }
    if (v.scopeKind === "variant") { const [x] = await this.db.select({ n: product.title, sku: variant.sku }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.id, value!), eq(variant.orgId, orgId))); if (!x) throw new NotFoundException({ code: "scope_not_found" }); label = `${x.n} · ${x.sku}`; }
    if (v.scopeKind === "brand") label = value!;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"commission-rules:" + orgId}))`);
      const [found] = await tx.select().from(commissionRuleSet).where(and(eq(commissionRuleSet.orgId, orgId), eq(commissionRuleSet.scopeKind, v.scopeKind), sql`coalesce(${commissionRuleSet.scopeValue}, '') = ${value ?? ""}`));
      const set = found ?? (await tx.insert(commissionRuleSet).values({ orgId, name: label, scopeKind: v.scopeKind, scopeValue: value, createdBy: actorId }).returning())[0]!;
      const existing = await tx.select().from(commissionRule).where(eq(commissionRule.ruleSetId, set.id));
      if (existing.some((e) => String(e.validFrom) === v.validFrom)) throw new ConflictException({ code: "version_date_taken", validFrom: v.validFrom });
      const next = existing.reduce((m, e) => Math.max(m, e.version), 0) + 1;
      const [row] = await tx.insert(commissionRule).values({ ruleSetId: set.id, version: next, validFrom: v.validFrom, enabled: v.enabled, basis: v.basis, rateBp: v.rateBp, splitMode: v.splitMode, weights: v.weights, note: v.note ?? null, createdBy: actorId }).returning();
      await this.audit.record({ orgId, actorId, action: "commission.rule", subjectType: "commission_rule_set", subjectId: set.id, before: existing.length ? { version: existing.at(-1)!.version } : null, after: { scope: v.scopeKind, value, version: next, validFrom: v.validFrom, enabled: v.enabled, basis: v.basis, rateBp: v.rateBp, splitMode: v.splitMode }, ip }, tx);
      return { id: row!.id, ruleSetId: set.id, version: next };
    });
  }

  /** What a sale line would earn, with the rule that would apply: the "try it" panel. */
  async preview(orgId: string, o: { variantId: string; locationId: string; date: string; qty: number; totalMinor: number }) {
    if (!isDate(o.date)) throw new BadRequestException({ code: "bad_date" });
    const [x] = await this.db.select({ v: variant, p: product }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.id, o.variantId), eq(variant.orgId, orgId)));
    const [loc] = await this.db.select().from(location).where(and(eq(location.id, o.locationId), eq(location.orgId, orgId)));
    if (!x || !loc) throw new NotFoundException({ code: "not_found" });
    const rates = await this.db.select().from(taxRate).where(and(eq(taxRate.taxClassId, x.p.taxClassId), sql`${taxRate.validFrom} <= ${o.date}::date and (${taxRate.validTo} is null or ${taxRate.validTo} > ${o.date}::date)`));
    const rate = rates.find((r) => r.region && r.region === loc.taxRegion) ?? rates.find((r) => !r.region) ?? null;
    const tax = rate ? (rate.taxInclusive ? taxFromInclusive(o.totalMinor, rate.rateBp) : 0) : 0;
    const sets = await this.loadSets(orgId); const rule = pickRule(sets, { locationId: o.locationId, categoryId: x.p.categoryId, brand: x.p.brand, variantId: o.variantId }, o.date);
    const [avg] = await this.db.execute(sql`select avg_cost_minor from shelfline.stock_balance where variant_id = ${o.variantId} and location_id = ${o.locationId}`).then((r) => r.rows as Row[]);
    const cost = (avg?.avg_cost_minor as number | null | undefined) ?? x.v.costMinor ?? null;
    const set = rule ? sets.find((s) => s.versions.some((vv) => vv.id === rule.id))! : null;
    if (!rule) return { rule: null, taxMinor: tax, baseMinor: 0, commissionMinor: 0 };
    const base = baseOf(rule.basis, { qty: o.qty, totalMinor: o.totalMinor, taxMinor: tax, unitCostMinor: cost });
    return { rule: { id: rule.id, scopeKind: set!.scopeKind, version: rule.version, basis: rule.basis, rateBp: rule.rateBp, splitMode: rule.splitMode }, taxMinor: tax, unitCostMinor: cost, baseMinor: base, commissionMinor: commissionOf(base, rule.rateBp) };
  }

  // ------------------------------------------------------------ periods
  async createPeriod(orgId: string, actorId: string, o: { from: string; to: string }, ip: string | null) {
    if (!isDate(o.from) || !isDate(o.to) || o.to < o.from) throw new BadRequestException({ code: "bad_range" });
    if ((Date.parse(o.to) - Date.parse(o.from)) / 86_400_000 > 92) throw new BadRequestException({ code: "range_too_long" });
    try {
      return await this.db.transaction(async (tx) => {
        const [p] = await tx.insert(commissionPeriod).values({ orgId, startDate: o.from, endDate: o.to }).returning();
        await this.audit.record({ orgId, actorId, action: "commission.period.create", subjectType: "commission_period", subjectId: p!.id, after: o, ip }, tx);
        return { id: p!.id, startDate: o.from, endDate: o.to, status: "open" };
      });
    } catch (e) { if ((e as { code?: string; cause?: { code?: string } }).code === "23P01" || (e as { cause?: { code?: string } }).cause?.code === "23P01") throw new ConflictException({ code: "period_overlap" }); throw e; }
  }

  async listPeriods(orgId: string) {
    const rows = (await this.db.execute(sql`select p.id, p.start_date::text as start_date, p.end_date::text as end_date, p.status, p.locked_at,
        coalesce(sum(e.amount_minor) filter (where e.kind = 'earn'), 0)::int as earned, coalesce(sum(e.amount_minor) filter (where e.kind = 'clawback'), 0)::int as clawback,
        coalesce(sum(e.amount_minor) filter (where e.kind = 'adjust'), 0)::int as adjust, coalesce(sum(e.amount_minor), 0)::int as net, count(distinct e.user_id)::int as people
      from shelfline.commission_period p left join shelfline.commission_entry e on e.period_id = p.id where p.org_id = ${orgId} group by p.id order by p.start_date desc`)).rows as Row[];
    return rows.map((r) => ({ id: r.id as string, startDate: r.start_date as string, endDate: r.end_date as string, status: r.status as string, lockedAt: r.locked_at, earnedMinor: Number(r.earned), clawbackMinor: Number(r.clawback), adjustMinor: Number(r.adjust), netMinor: Number(r.net), people: Number(r.people) }));
  }

  private async period(orgId: string, id: string) { const [p] = await this.db.select().from(commissionPeriod).where(and(eq(commissionPeriod.id, id), eq(commissionPeriod.orgId, orgId))); if (!p) throw new NotFoundException({ code: "period_not_found" }); return p; }

  /** Totals per person: the stored statement once locked, otherwise live from the entries. */
  async statements(orgId: string, periodId: string) {
    const p = await this.period(orgId, periodId);
    if (p.status === "locked") {
      const rows = await this.db.select({ s: commissionStatement, name: user.name }).from(commissionStatement).innerJoin(user, eq(user.id, commissionStatement.userId)).where(eq(commissionStatement.periodId, periodId));
      return { period: this.shape(p), people: rows.map((r) => ({ userId: r.s.userId, user: r.name, earnedMinor: r.s.earnedMinor, clawbackMinor: r.s.clawbackMinor, adjustMinor: r.s.adjustMinor, netMinor: r.s.netMinor, entries: r.s.entries })).sort((a, b) => b.netMinor - a.netMinor || a.user.localeCompare(b.user)) };
    }
    return { period: this.shape(p), people: await this.liveTotals(periodId) };
  }
  private shape(p: typeof commissionPeriod.$inferSelect) { return { id: p.id, startDate: String(p.startDate), endDate: String(p.endDate), status: p.status, lockedAt: p.lockedAt }; }
  private async liveTotals(periodId: string, db: Pick<Db, "execute"> = this.db) {
    const rows = (await db.execute(sql`select e.user_id, u.name, coalesce(sum(e.amount_minor) filter (where e.kind = 'earn'), 0)::int as earned, coalesce(sum(e.amount_minor) filter (where e.kind = 'clawback'), 0)::int as clawback,
        coalesce(sum(e.amount_minor) filter (where e.kind = 'adjust'), 0)::int as adjust, sum(e.amount_minor)::int as net, count(*)::int as entries
      from shelfline.commission_entry e join shelfline."user" u on u.id = e.user_id where e.period_id = ${periodId} group by e.user_id, u.name`)).rows as Row[];
    return rows.map((r) => ({ userId: r.user_id as string, user: r.name as string, earnedMinor: Number(r.earned), clawbackMinor: Number(r.clawback), adjustMinor: Number(r.adjust), netMinor: Number(r.net), entries: Number(r.entries) })).sort((a, b) => b.netMinor - a.netMinor || a.user.localeCompare(b.user));
  }

  /** Every entry behind one person's number, with the receipt it came from. */
  async detail(orgId: string, periodId: string, userId: string) {
    const p = await this.period(orgId, periodId);
    const rows = (await this.db.execute(sql`select e.id, e.kind, e.source_kind, e.source_id, e.line_no, e.base_minor, e.amount_minor, e.local_date::text as local_date, e.late, e.reason, l.name as location,
        coalesce(s.receipt_no, rs.receipt_no) as receipt_no, p.title, v.sku, r.rate_bp, r.basis, r.split_mode, r.version, set.scope_kind
      from shelfline.commission_entry e left join shelfline.location l on l.id = e.location_id
        left join shelfline.sale s on e.source_kind = 'sale' and s.id = e.source_id
        left join shelfline.refund rf on e.source_kind = 'refund' and rf.id = e.source_id left join shelfline.sale rs on rs.id = rf.sale_id
        left join shelfline.sale_line sl on sl.sale_id = coalesce(s.id, rs.id) and sl.line_no = case when e.source_kind = 'sale' then e.line_no else (select rl.sale_line_no from shelfline.refund_line rl where rl.refund_id = rf.id and rl.line_no = e.line_no) end
        left join shelfline.variant v on v.id = sl.variant_id left join shelfline.product p on p.id = v.product_id
        left join shelfline.commission_rule r on r.id = e.rule_id left join shelfline.commission_rule_set set on set.id = r.rule_set_id
      where e.period_id = ${periodId} and e.user_id = ${userId} order by e.local_date, e.created_at, e.source_id, e.line_no`)).rows as Row[];
    const [u] = await this.db.select({ name: user.name }).from(user).where(and(eq(user.id, userId), eq(user.orgId, orgId)));
    return { period: this.shape(p), user: u?.name ?? null, entries: rows.map((r) => ({ id: r.id, kind: r.kind, sourceKind: r.source_kind, receiptNo: r.receipt_no ?? null, lineNo: r.line_no, date: r.local_date, location: r.location ?? null, item: r.title ? `${r.title} · ${r.sku}` : null, baseMinor: r.base_minor, amountMinor: r.amount_minor, late: r.late, reason: r.reason, rateBp: r.rate_bp ?? null, basis: r.basis ?? null, splitMode: r.split_mode ?? null, ruleVersion: r.version ?? null, scopeKind: r.scope_kind ?? null })) };
  }

  async csv(orgId: string, periodId: string) {
    const st = await this.statements(orgId, periodId); const lines = ["person,earned,clawback,adjustments,net,entries"];
    for (const p of st.people) lines.push([p.user, money(p.earnedMinor), money(p.clawbackMinor), money(p.adjustMinor), money(p.netMinor), p.entries].map(csvCell).join(","));
    return { csv: lines.join("\n") + "\n", name: `commission-${st.period.startDate}-${st.period.endDate}.csv` };
  }

  /** A correction after a period closed (or any manual change) is an `adjust` entry in the earliest open period; the closed period is never touched. */
  async adjust(orgId: string, actorId: string, o: { userId: string; amountMinor: number; reason: string }, ip: string | null) {
    const [u] = await this.db.select({ id: user.id }).from(user).where(and(eq(user.id, o.userId), eq(user.orgId, orgId))); if (!u) throw new NotFoundException({ code: "user_not_found" });
    if (o.amountMinor === 0) throw new BadRequestException({ code: "zero_amount" });
    return this.db.transaction(async (tx) => {
      const [open] = await tx.select().from(commissionPeriod).where(and(eq(commissionPeriod.orgId, orgId), eq(commissionPeriod.status, "open"))).orderBy(asc(commissionPeriod.startDate)).limit(1);
      if (!open) throw new ConflictException({ code: "no_open_period" });
      const today = new Date().toISOString().slice(0, 10); const sourceId = crypto.randomUUID();
      const [e] = await tx.insert(commissionEntry).values({ orgId, periodId: open.id, userId: o.userId, kind: "adjust", sourceKind: "adjust", sourceId, amountMinor: o.amountMinor, localDate: today < String(open.startDate) ? String(open.startDate) : today > String(open.endDate) ? String(open.endDate) : today, reason: o.reason, createdBy: actorId }).returning();
      await this.audit.record({ orgId, actorId, action: "commission.adjust", subjectType: "commission_entry", subjectId: e!.id, after: { userId: o.userId, amountMinor: o.amountMinor, periodId: open.id }, detail: { reason: o.reason }, ip }, tx);
      return { id: e!.id, periodId: open.id };
    });
  }

  /** Closing a period freezes its entries (a trigger enforces it) and writes the statements. Periods close in order, and only after they have ended. */
  async lock(orgId: string, actorId: string, periodId: string, ip: string | null) {
    const p = await this.period(orgId, periodId);
    if (p.status !== "open") throw new ConflictException({ code: "already_locked" });
    if (String(p.endDate) >= new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10)) throw new ConflictException({ code: "period_not_ended" });
    const [earlier] = await this.db.select({ id: commissionPeriod.id }).from(commissionPeriod).where(and(eq(commissionPeriod.orgId, orgId), eq(commissionPeriod.status, "open"), sql`${commissionPeriod.startDate} < ${String(p.startDate)}::date`)).limit(1);
    if (earlier) throw new ConflictException({ code: "earlier_period_open" });
    await this.recalculate(orgId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"commission:" + orgId}))`);
      const [cur] = await tx.select().from(commissionPeriod).where(eq(commissionPeriod.id, periodId)).for("update"); if (cur!.status !== "open") throw new ConflictException({ code: "already_locked" });
      const totals = await this.liveTotals(periodId, tx);
      if (totals.length) await tx.insert(commissionStatement).values(totals.map((t) => ({ periodId, userId: t.userId, earnedMinor: t.earnedMinor, clawbackMinor: t.clawbackMinor, adjustMinor: t.adjustMinor, netMinor: t.netMinor, entries: t.entries })));
      await tx.update(commissionPeriod).set({ status: "locked", lockedAt: sql`now()`, lockedBy: actorId }).where(eq(commissionPeriod.id, periodId));
      await this.audit.record({ orgId, actorId, action: "commission.period.lock", subjectType: "commission_period", subjectId: periodId, after: { people: totals.length, netMinor: totals.reduce((a, t) => a + t.netMinor, 0) }, ip }, tx);
      return { id: periodId, status: "locked", people: totals.length, netMinor: totals.reduce((a, t) => a + t.netMinor, 0) };
    });
  }

  // ------------------------------------------------------------ the allocation engine
  /**
   * Rebuilds every open period from the sales and refunds, the rule versions in force on each sale's date, and the timesheets.
   * It deletes and re-derives, so running it twice gives the same rows. Adjustments are kept. A sale or refund that reached the server after its period
   * had already closed is placed in the earliest open period (marked late) instead of changing the closed one.
   */
  async recalculate(orgId: string) {
    const periods = await this.db.select().from(commissionPeriod).where(eq(commissionPeriod.orgId, orgId)).orderBy(asc(commissionPeriod.startDate));
    const open = periods.filter((p) => p.status === "open"); if (!open.length) return { periods: 0, entries: 0 };
    const target = open[0]!; const sets = await this.loadSets(orgId);
    const usesShift = sets.some((s) => s.versions.some((v) => v.enabled && v.splitMode !== "seller"));

    // sales and refunds that belong to an open period, or that arrived after theirs closed
    const cond = (alias: string, at: string) => sql`(p.status = 'open' or (p.locked_at < ${sql.raw(alias)}.${sql.raw(at)} and not exists (select 1 from shelfline.commission_entry e join shelfline.commission_period ep on ep.id = e.period_id and ep.status <> 'open' where e.source_kind = ${alias === "s" ? "sale" : "refund"} and e.source_id = ${sql.raw(alias)}.id)))`;
    const sales = (await this.db.execute(sql`select s.id, s.location_id, s.local_date::text as local_date, s.effective_at, s.cashier_id, p.id as period_id, p.status as period_status from shelfline.sale s
      join shelfline.commission_period p on p.org_id = s.org_id and s.local_date between p.start_date and p.end_date where s.org_id = ${orgId} and s.status in ('completed', 'partially_refunded', 'refunded') and ${cond("s", "received_at")} order by s.local_date, s.id`)).rows as Row[];
    const refunds = (await this.db.execute(sql`select s.id, s.sale_id, s.location_id, s.local_date::text as local_date, s.at, p.id as period_id, p.status as period_status from shelfline.refund s
      join shelfline.commission_period p on p.org_id = s.org_id and s.local_date between p.start_date and p.end_date where s.org_id = ${orgId} and ${cond("s", "at")} order by s.local_date, s.at, s.id`)).rows as Row[];

    // timesheets for the split modes that need to know who was working
    const dates = [...sales, ...refunds].map((r) => r.local_date as string); const locs = [...new Set(sales.map((s) => s.location_id as string))];
    if (usesShift && dates.length) { const from = dates.reduce((a, b) => (a < b ? a : b)), to = dates.reduce((a, b) => (a > b ? a : b)); for (const l of locs) await this.workforce.sync(orgId, l, from, to); }
    const sheets = usesShift && locs.length ? (await this.db.execute(sql`select user_id, location_id, local_date::text as local_date, extract(epoch from in_at) * 1000 as in_ms, extract(epoch from out_at) * 1000 as out_ms, worked_minutes
      from shelfline.timesheet_entry where org_id = ${orgId} and location_id in (${sql.join(locs.map((l) => sql`${l}::uuid`), sql`, `)}) and local_date between ${addDays(dates.reduce((a, b) => (a < b ? a : b)), -1)}::date and ${addDays(dates.reduce((a, b) => (a > b ? a : b)), 1)}::date`)).rows as Row[] : [];
    const roles = usesShift ? (await this.db.execute(sql`select ua.user_id, ua.location_id, r.key from shelfline.user_assignment ua join shelfline.role r on r.id = ua.role_id where r.org_id = ${orgId}`)).rows as Row[] : [];
    const roleAt = (uid: string, loc: string) => { const mine = roles.filter((r) => r.user_id === uid && (r.location_id === loc || r.location_id === null)); return (mine.find((r) => r.location_id === loc) ?? mine[0])?.key as string | undefined ?? null; };
    const onShift = (loc: string, ms: number) => [...new Set(sheets.filter((t) => t.location_id === loc && Number(t.in_ms) <= ms && ms <= (t.out_ms === null ? Number(t.in_ms) + 16 * 3_600_000 : Number(t.out_ms))).map((t) => t.user_id as string))].map((userId) => ({ userId, role: roleAt(userId, loc) }));
    const minutesOn = (loc: string, date: string) => { const m = new Map<string, number>(); for (const t of sheets) if (t.location_id === loc && t.local_date === date && t.worked_minutes !== null) m.set(t.user_id as string, (m.get(t.user_id as string) ?? 0) + Number(t.worked_minutes)); return m; };

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"commission:" + orgId}))`);
      await tx.execute(sql`delete from shelfline.commission_entry where org_id = ${orgId} and kind in ('earn', 'clawback') and period_id in (${sql.join(open.map((p) => sql`${p.id}::uuid`), sql`, `)})`);
      const out: (typeof commissionEntry.$inferInsert)[] = [];
      const periodFor = (r: Row) => (r.period_status === "open" ? (r.period_id as string) : target.id); const isLate = (r: Row) => r.period_status !== "open";

      // earnings
      const saleIds = sales.map((s) => s.id as string);
      const lines = saleIds.length ? (await tx.execute(sql`select sl.sale_id, sl.line_no, sl.variant_id, sl.qty, sl.total_minor, sl.tax_minor, sl.unit_cost_minor, sl.attributed_to, p.category_id, p.brand
        from shelfline.sale_line sl join shelfline.variant v on v.id = sl.variant_id join shelfline.product p on p.id = v.product_id where sl.sale_id in (${sql.join(saleIds.map((i) => sql`${i}::uuid`), sql`, `)}) order by sl.sale_id, sl.line_no`)).rows as Row[] : [];
      const bySale = new Map<string, Row[]>(); for (const l of lines) (bySale.get(l.sale_id as string) ?? bySale.set(l.sale_id as string, []).get(l.sale_id as string)!).push(l);
      const earned = new Map<string, { userId: string; amountMinor: number; ruleId: string; baseMinor: number }[]>();
      for (const s of sales) {
        const date = s.local_date as string; const loc = s.location_id as string; const at = new Date(s.effective_at as string).getTime();
        for (const l of bySale.get(s.id as string) ?? []) {
          const rule = pickRule(sets, { locationId: loc, categoryId: (l.category_id as string | null) ?? null, brand: (l.brand as string | null) ?? null, variantId: l.variant_id as string }, date); if (!rule) continue;
          const base = baseOf(rule.basis, { qty: Number(l.qty), totalMinor: Number(l.total_minor), taxMinor: Number(l.tax_minor), unitCostMinor: l.unit_cost_minor === null ? null : Number(l.unit_cost_minor) });
          const total = commissionOf(base, rule.rateBp); if (total === 0) continue;
          const parts = recipients(rule.splitMode, rule.weights, { sellerId: l.attributed_to as string, onShift: rule.splitMode === "seller" ? [] : onShift(loc, at), minutes: rule.splitMode === "hours_pool" ? minutesOn(loc, date) : new Map() });
          const shares = split(total, parts); const rows = shares.map((x) => ({ userId: x.userId, amountMinor: x.amountMinor, ruleId: rule.id, baseMinor: Math.round(base * (x.amountMinor / total)) }));
          earned.set(`${s.id}:${l.line_no}`, rows);
          for (const x of rows) out.push({ orgId, periodId: periodFor(s), userId: x.userId, locationId: loc, kind: "earn", sourceKind: "sale", sourceId: s.id as string, lineNo: Number(l.line_no), ruleId: x.ruleId, baseMinor: x.baseMinor, amountMinor: x.amountMinor, localDate: date, late: isLate(s) });
        }
      }

      // clawbacks: earnings of each refunded line (from this run, or fixed in a closed period) and every refund of that line in time order
      if (refunds.length) {
        const refundIds = refunds.map((r) => r.id as string); const saleOf = [...new Set(refunds.map((r) => r.sale_id as string))];
        const rl = (await tx.execute(sql`select rl.refund_id, rl.line_no, rl.sale_line_no, rl.qty, rl.amount_minor, rl.tax_minor, sl.qty as line_qty from shelfline.refund_line rl join shelfline.refund r on r.id = rl.refund_id
          join shelfline.sale_line sl on sl.sale_id = r.sale_id and sl.line_no = rl.sale_line_no where rl.refund_id in (${sql.join(refundIds.map((i) => sql`${i}::uuid`), sql`, `)}) order by rl.refund_id, rl.line_no`)).rows as Row[];
        // all refunds of those sales, earlier ones included, so the running total is right
        const hist = (await tx.execute(sql`select r.id as refund_id, r.at, rl.sale_line_no, rl.qty, r.sale_id from shelfline.refund r join shelfline.refund_line rl on rl.refund_id = r.id where r.sale_id in (${sql.join(saleOf.map((i) => sql`${i}::uuid`), sql`, `)}) order by r.at, r.id, rl.line_no`)).rows as Row[];
        const fixed = (await tx.execute(sql`select source_id, line_no, user_id, amount_minor, rule_id, base_minor from shelfline.commission_entry where kind = 'earn' and source_kind = 'sale' and source_id in (${sql.join(saleOf.map((i) => sql`${i}::uuid`), sql`, `)})`)).rows as Row[];
        const earnOf = (saleId: string, lineNo: number) => earned.get(`${saleId}:${lineNo}`) ?? fixed.filter((f) => f.source_id === saleId && Number(f.line_no) === lineNo).map((f) => ({ userId: f.user_id as string, amountMinor: Number(f.amount_minor), ruleId: f.rule_id as string, baseMinor: Number(f.base_minor) }));
        const perLine = new Map<string, { key: string; qty: number }[]>(); for (const h of hist) { const k = `${h.sale_id}:${h.sale_line_no}`; (perLine.get(k) ?? perLine.set(k, []).get(k)!).push({ key: `${h.refund_id}:${h.sale_line_no}`, qty: Number(h.qty) }); }
        const claw = new Map<string, Map<string, { userId: string; amountMinor: number }[]>>();
        for (const x of rl) { const refund = refunds.find((r) => r.id === x.refund_id)!; const k = `${refund.sale_id}:${x.sale_line_no}`;
          if (!claw.has(k)) claw.set(k, clawbacks(earnOf(refund.sale_id as string, Number(x.sale_line_no)), Number(x.line_qty), perLine.get(k) ?? [])); }
        for (const x of rl) {
          const refund = refunds.find((r) => r.id === x.refund_id)!; const k = `${refund.sale_id}:${x.sale_line_no}`; const earnRows = earnOf(refund.sale_id as string, Number(x.sale_line_no));
          for (const c of claw.get(k)?.get(`${x.refund_id}:${x.sale_line_no}`) ?? []) {
            const src = earnRows.find((e) => e.userId === c.userId);
            out.push({ orgId, periodId: periodFor(refund), userId: c.userId, locationId: refund.location_id as string, kind: "clawback", sourceKind: "refund", sourceId: refund.id as string, lineNo: Number(x.line_no), ruleId: src?.ruleId ?? null, baseMinor: -(Number(x.amount_minor) - Number(x.tax_minor)), amountMinor: c.amountMinor, localDate: refund.local_date as string, late: isLate(refund) });
          }
        }
      }
      for (let i = 0; i < out.length; i += 500) await tx.insert(commissionEntry).values(out.slice(i, i + 500));
      return { periods: open.length, entries: out.length };
    });
  }
}
