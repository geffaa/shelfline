import { sql } from "drizzle-orm";
import type { Db } from "../db/db.module";
import type { Tx } from "../inventory/ledger.service";

export interface ZReport {
  sessionId: string; openingFloatMinor: number;
  cash: { salesMinor: number; salesCount: number; refundsMinor: number; refundsCount: number; payInMinor: number; payOutMinor: number; dropMinor: number; floatAddMinor: number };
  expectedMinor: number;
  tenders: { cashMinor: number; cardMinor: number; otherMinor: number };
  salesCount: number; grossSalesMinor: number; refundsMinor: number; refundsCount: number; netSalesMinor: number; gstMinor: number; noSaleCount: number;
}
type Q = Pick<Db, "execute"> | Tx;

/**
 * The one definition of "expected cash in the drawer" and of the day's figures for a register session. The till shows a provisional copy of
 * this while offline; the server's answer at close is final. Expected = float + cash sales - cash refunds + pay-ins + float adds - pay-outs - drops.
 */
export async function zReport(db: Q, sessionId: string): Promise<ZReport | null> {
  const r = await db.execute(sql`
    with s as (select id, opening_float_minor from shelfline.register_session where id = ${sessionId}),
    sales as (select id, tax_minor, payable_minor from shelfline.sale where session_id = ${sessionId}),
    pay as (select p.tender, sum(p.amount_minor)::int as amt, count(distinct p.sale_id)::int as n from shelfline.payment p join sales on sales.id = p.sale_id group by p.tender),
    refunds as (select tender, sum(total_minor)::int as amt, count(*)::int as n, sum(tax_minor)::int as tax from shelfline.refund where session_id = ${sessionId} group by tender),
    mv as (select kind, sum(amount_minor)::int as amt, count(*)::int as n from shelfline.cash_movement where session_id = ${sessionId} group by kind)
    select
      (select opening_float_minor from s) as opening,
      coalesce((select amt from pay where tender = 'cash'), 0) as cash_sales, coalesce((select n from pay where tender = 'cash'), 0) as cash_sales_n,
      coalesce((select amt from pay where tender = 'card'), 0) as card_sales, coalesce((select amt from pay where tender = 'other'), 0) as other_sales,
      coalesce((select amt from refunds where tender = 'cash'), 0) as cash_refunds, coalesce((select n from refunds where tender = 'cash'), 0) as cash_refunds_n,
      coalesce((select sum(amt) from refunds), 0)::int as refunds_total, coalesce((select sum(n) from refunds), 0)::int as refunds_n, coalesce((select sum(tax) from refunds), 0)::int as refunds_tax,
      coalesce((select amt from mv where kind = 'pay_in'), 0) as pay_in, coalesce((select amt from mv where kind = 'pay_out'), 0) as pay_out,
      coalesce((select amt from mv where kind = 'drop'), 0) as drop_amt, coalesce((select amt from mv where kind = 'float_add'), 0) as float_add, coalesce((select n from mv where kind = 'no_sale'), 0) as no_sales,
      (select count(*)::int from sales) as sales_n, coalesce((select sum(tax_minor) from sales), 0)::int as sales_tax`);
  const x = r.rows[0] as Record<string, number | null> | undefined;
  if (!x || x.opening === null) return null;
  const n = (k: string) => Number(x[k] ?? 0);
  const cashSales = n("cash_sales"), cashRefunds = n("cash_refunds");
  const gross = cashSales + n("card_sales") + n("other_sales");
  return {
    sessionId, openingFloatMinor: n("opening"),
    cash: { salesMinor: cashSales, salesCount: n("cash_sales_n"), refundsMinor: cashRefunds, refundsCount: n("cash_refunds_n"), payInMinor: n("pay_in"), payOutMinor: n("pay_out"), dropMinor: n("drop_amt"), floatAddMinor: n("float_add") },
    expectedMinor: n("opening") + cashSales - cashRefunds + n("pay_in") + n("float_add") - n("pay_out") - n("drop_amt"),
    tenders: { cashMinor: cashSales, cardMinor: n("card_sales"), otherMinor: n("other_sales") },
    salesCount: n("sales_n"), grossSalesMinor: gross, refundsMinor: n("refunds_total"), refundsCount: n("refunds_n"), netSalesMinor: gross - n("refunds_total"), gstMinor: n("sales_tax") - n("refunds_tax"), noSaleCount: n("no_sales"),
  };
}
