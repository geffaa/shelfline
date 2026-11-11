import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { locationScope } from "./scope";

export type GroupBy = "day" | "location" | "product";
export interface SalesRow { key: string; label: string; orders: number; items: number; grossMinor: number; discountMinor: number; refundsMinor: number; netMinor: number; taxMinor: number }
const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

const csvCell = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(rows: SalesRow[]): string {
  const money = (n: number) => (n / 100).toFixed(2);
  return ["label,orders,items,gross,discounts,refunds,net,gst_included", ...rows.map((r) => [r.label, r.orders, r.items, money(r.grossMinor), money(r.discountMinor), money(r.refundsMinor), money(r.netMinor), money(r.taxMinor)].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService) {}

  /** Sales by day, location or product for a range of business dates. Net = gross - refunds; refunds count on the day they were given. */
  async sales(orgId: string, userId: string, o: { locationId?: string; from: string; to: string; groupBy: GroupBy }): Promise<SalesRow[]> {
    const ids = await locationScope(this.authz, userId, "report:read", o.locationId);
    const sc = (alias: string) => ids === null ? sql`true` : ids.length ? sql`${sql.raw(alias)}.location_id in (${idList(ids)})` : sql`false`;
    const key = { day: [sql`s.local_date::text`, sql`s.local_date::text`], location: [sql`l.id::text`, sql`l.name`], product: [sql`p.id::text`, sql`p.title`] } as const;
    let sales, refunds;
    if (o.groupBy === "product") {
      sales = await this.db.execute(sql`select p.id::text as k, p.title as label, count(distinct s.id)::int as orders, sum(sl.qty)::int as items, sum(sl.total_minor + 0)::int as gross, sum(sl.discount_minor)::int as discount, sum(sl.tax_minor)::int as tax
        from shelfline.sale_line sl join shelfline.sale s on s.id = sl.sale_id join shelfline.variant v on v.id = sl.variant_id join shelfline.product p on p.id = v.product_id
        where s.org_id = ${orgId} and ${sc("s")} and s.local_date between ${o.from}::date and ${o.to}::date group by p.id, p.title`);
      refunds = await this.db.execute(sql`select p.id::text as k, sum(rl.amount_minor)::int as amt from shelfline.refund_line rl join shelfline.refund r on r.id = rl.refund_id join shelfline.variant v on v.id = rl.variant_id join shelfline.product p on p.id = v.product_id
        where r.org_id = ${orgId} and ${sc("r")} and r.local_date between ${o.from}::date and ${o.to}::date group by p.id`);
    } else {
      const [k, label] = key[o.groupBy];
      sales = await this.db.execute(sql`select ${k} as k, ${label} as label, count(s.id)::int as orders, coalesce(sum((select sum(qty) from shelfline.sale_line x where x.sale_id = s.id)), 0)::int as items, sum(s.total_minor)::int as gross, sum(s.discount_minor)::int as discount, sum(s.tax_minor)::int as tax
        from shelfline.sale s join shelfline.location l on l.id = s.location_id where s.org_id = ${orgId} and ${sc("s")} and s.local_date between ${o.from}::date and ${o.to}::date group by 1, 2`);
      const rk = o.groupBy === "day" ? sql`r.local_date::text` : sql`l.id::text`;
      refunds = await this.db.execute(sql`select ${rk} as k, sum(r.total_minor)::int as amt from shelfline.refund r join shelfline.location l on l.id = r.location_id where r.org_id = ${orgId} and ${sc("r")} and r.local_date between ${o.from}::date and ${o.to}::date group by 1`);
    }
    const rf = new Map(refunds.rows.map((x) => [String(x.k), Number(x.amt)]));
    const rows = sales.rows.map((x): SalesRow => ({ key: String(x.k), label: String(x.label), orders: Number(x.orders), items: Number(x.items), grossMinor: Number(x.gross), discountMinor: Number(x.discount), refundsMinor: rf.get(String(x.k)) ?? 0, netMinor: Number(x.gross) - (rf.get(String(x.k)) ?? 0), taxMinor: Number(x.tax) }));
    for (const [k, amt] of rf) if (!rows.some((r) => r.key === k)) rows.push({ key: k, label: k, orders: 0, items: 0, grossMinor: 0, discountMinor: 0, refundsMinor: amt, netMinor: -amt, taxMinor: 0 });
    return rows.sort((a, b) => (o.groupBy === "day" ? a.key.localeCompare(b.key) : b.netMinor - a.netMinor));
  }
}
