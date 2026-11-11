import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { businessDate } from "../common/business-day";
import { DB, type Db } from "../db/db.module";
import { reportDef, type ColumnDef } from "./catalog";
import type { ReportScope, Request, Served } from "./scope";

export interface RunResult {
  key: string; title: string; groupBy: string | null; columns: ColumnDef[]; rows: Record<string, unknown>[]; totals: Record<string, number> | null;
  scope: { from: string; to: string; window: { from: string; to: string }; clamped: boolean; empty: boolean; locations: string[] | null; hiddenColumns: string[] };
}
const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Reports for outside readers. Every query takes its places and dates from a `Served` produced by `ReportScope.clamp()`, never from the caller. */
@Injectable()
export class ReportRunner {
  constructor(@Inject(DB) private db: Db) {}

  async run(orgId: string, key: string, scope: ReportScope, req: Request & { groupBy?: string | null }): Promise<RunResult> {
    const def = reportDef(key); if (!def) throw new NotFoundException({ code: "report_not_found" });
    const served = scope.clamp(req);
    const groupBy = def.groupBys.length ? (def.groupBys.includes(req.groupBy ?? "") ? req.groupBy! : def.defaultGroupBy) : null;
    let rows: Record<string, unknown>[] = [];
    if (!served.empty) rows = key === "sales" ? await this.sales(orgId, served, groupBy as "day" | "location" | "product", scope) : await this.cashVariance(orgId, served);
    const columns = scope.columns(def.columns);
    const visible = scope.strip(rows) as Record<string, unknown>[];
    const totals: Record<string, number> | null = def.key === "sales" ? Object.fromEntries(columns.filter((c) => c.kind !== "text").map((c) => [c.key, visible.reduce((a, r) => a + Number(r[c.key] ?? 0), 0)])) : null;
    const locations = served.locationIds === null ? null : (await this.db.execute(sql`select name from shelfline.location where org_id = ${orgId} and id in (${idList(served.locationIds.length ? served.locationIds : ["00000000-0000-0000-0000-000000000000"])}) order by name`)).rows.map((r) => String(r.name));
    return { key, title: def.title, groupBy, columns, rows: visible, totals, scope: { from: served.from, to: served.to, window: scope.window, clamped: served.clamped, empty: served.empty, locations, hiddenColumns: [...scope.hidden] } };
  }

  private async sales(orgId: string, s: Served, groupBy: "day" | "location" | "product", scope: ReportScope) {
    const where = sql`s.org_id = ${orgId} and s.status in ('completed', 'partially_refunded', 'refunded') and s.local_date between ${s.from}::date and ${s.to}::date and ${s.locationIds === null ? sql`true` : sql`s.location_id in (${idList(s.locationIds)})`}`;
    const [k, label, joins] = groupBy === "day" ? [sql`s.local_date::text`, sql`s.local_date::text`, sql``] : groupBy === "location" ? [sql`l.id::text`, sql`l.name`, sql`join shelfline.location l on l.id = s.location_id`]
      : [sql`p.id::text`, sql`p.title`, sql`join shelfline.variant v on v.id = sl.variant_id join shelfline.product p on p.id = v.product_id`];
    const res = await this.db.execute(sql`select ${k} as k, ${label} as label, count(distinct s.id)::int as orders, coalesce(sum(sl.qty), 0)::int as items, coalesce(sum(sl.total_minor), 0)::int as gross,
        coalesce(sum(sl.discount_minor + sl.promo_discount_minor), 0)::int as discount, coalesce(sum(sl.refunded_minor), 0)::int as refunds, coalesce(sum(sl.total_minor - sl.refunded_minor), 0)::int as net,
        coalesce(sum(sl.tax_minor - sl.refunded_tax_minor), 0)::int as tax, coalesce(sum(coalesce(sl.unit_cost_minor, 0) * (sl.qty - sl.refunded_qty)), 0)::int as cost
      from shelfline.sale s join shelfline.sale_line sl on sl.sale_id = s.id ${joins} where ${where} group by 1, 2`);
    const rows = res.rows.map((r) => { const net = Number(r.net), tax = Number(r.tax), cost = Number(r.cost);
      return { key: String(r.k), label: String(r.label), orders: Number(r.orders), items: Number(r.items), grossMinor: Number(r.gross), discountMinor: Number(r.discount), refundsMinor: Number(r.refunds), netMinor: net, taxMinor: tax, costMinor: cost, marginMinor: net - tax - cost }; });
    // order by takings, unless takings are hidden: the order itself would give them away
    const by = scope.sortable("netMinor", "label");
    return rows.sort((a, b) => groupBy === "day" || by === "label" ? a.label.localeCompare(b.label) : b.netMinor - a.netMinor);
  }

  private async cashVariance(orgId: string, s: Served) {
    const day = 86_400_000; const lo = new Date(Date.parse(s.from + "T00:00:00Z") - 2 * day), hi = new Date(Date.parse(s.to + "T00:00:00Z") + 3 * day);
    const res = await this.db.execute(sql`select rs.opened_at, rs.expected_close_minor, rs.counted_close_minor, rs.variance_minor, r.name as register, l.name as location, l.timezone, l.day_cutoff::text as cutoff
      from shelfline.register_session rs join shelfline.register r on r.id = rs.register_id join shelfline.location l on l.id = rs.location_id
      where rs.org_id = ${orgId} and rs.status in ('closed', 'force_closed') and rs.opened_at >= ${lo.toISOString()}::timestamptz and rs.opened_at < ${hi.toISOString()}::timestamptz and ${s.locationIds === null ? sql`true` : sql`rs.location_id in (${idList(s.locationIds)})`}`);
    return res.rows.map((r) => ({ date: businessDate(new Date(String(r.opened_at)), String(r.timezone), String(r.cutoff)), location: String(r.location), register: String(r.register), expectedMinor: Number(r.expected_close_minor ?? 0), countedMinor: Number(r.counted_close_minor ?? 0), varianceMinor: Number(r.variance_minor ?? 0) }))
      .filter((r) => r.date >= s.from && r.date <= s.to).sort((a, b) => a.date.localeCompare(b.date) || a.location.localeCompare(b.location) || a.register.localeCompare(b.register));
  }

  toCsv(r: RunResult): string {
    const fmt = (c: ColumnDef, v: unknown) => (c.kind === "money" ? (Number(v ?? 0) / 100).toFixed(2) : v);
    const head = r.columns.map((c) => csvCell(c.label || (r.groupBy ? r.groupBy[0]!.toUpperCase() + r.groupBy.slice(1) : "")));
    const body = r.rows.map((row) => r.columns.map((c) => csvCell(fmt(c, row[c.key]))).join(","));
    const foot = r.totals ? [r.columns.map((c, i) => (i === 0 ? "Total" : c.kind === "text" ? "" : csvCell(fmt(c, r.totals![c.key])))).join(",")] : [];
    return [head.join(","), ...body, ...foot].join("\n") + "\n";
  }
}
