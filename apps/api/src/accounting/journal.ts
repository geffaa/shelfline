import { createHash } from "node:crypto";

/** What one store took and did on one trading day, in cents. Everything the journal is built from. */
export interface DayFigures {
  salesTotalMinor: number; salesTaxMinor: number; roundingMinor: number; tendersIn: Record<string, number>;
  refundsTotalMinor: number; refundsTaxMinor: number; tendersOut: Record<string, number>;
  varianceMinor: number; cogsMinor: number; cogsReturnedMinor: number;
}
export type AccountKey = "cash" | "card_clearing" | "gift_card_liability" | "store_credit_liability" | "other_clearing" | "sales_revenue" | "gst_collected" | "rounding" | "cash_over_short" | "cogs" | "inventory" | "suspense";
/** A journal line: positive is a debit, negative a credit. */
export interface Line { account: AccountKey; amountMinor: number; description: string }
const TENDER_ACCOUNT: Record<string, AccountKey> = { cash: "cash", card: "card_clearing", gift_card: "gift_card_liability", store_credit: "store_credit_liability", other: "other_clearing" };
export const ACCOUNT_LABEL: Record<AccountKey, string> = { cash: "Cash takings", card_clearing: "Card payments to clear", gift_card_liability: "Gift cards redeemed", store_credit_liability: "Store credit used", other_clearing: "Other payments", sales_revenue: "Sales (without GST)", gst_collected: "GST collected", rounding: "Cash rounding", cash_over_short: "Cash over and short", cogs: "Cost of goods sold", inventory: "Inventory", suspense: "Unreconciled difference" };

const merge = (ls: Line[]): Line[] => { const by = new Map<AccountKey, Line>(); for (const l of ls) { const e = by.get(l.account); if (e) e.amountMinor += l.amountMinor; else by.set(l.account, { ...l }); } return [...by.values()].filter((l) => l.amountMinor !== 0); };
export const sum = (ls: Line[]) => ls.reduce((a, l) => a + l.amountMinor, 0);

/**
 * The day as a journal. Money received goes in as debits against what was taken (cash, card clearing, ...), what was sold comes out as credits to sales without GST and to GST, refunds do the reverse,
 * a short or over drawer goes to over-and-short, and the cost of what left the shelf moves from inventory to cost of goods.
 * If the payments recorded do not add up to what the sales and refunds say, the difference is put on an "unreconciled" line rather than hidden, so the journal always balances and the gap is visible.
 */
export function buildJournal(f: DayFigures): { lines: Line[]; unreconciledMinor: number } {
  const L: Line[] = [];
  for (const [t, amt] of Object.entries(f.tendersIn)) L.push({ account: TENDER_ACCOUNT[t] ?? "other_clearing", amountMinor: amt, description: "Takings" });
  for (const [t, amt] of Object.entries(f.tendersOut)) L.push({ account: TENDER_ACCOUNT[t] ?? "other_clearing", amountMinor: -amt, description: "Refunds paid out" });
  L.push({ account: "sales_revenue", amountMinor: -((f.salesTotalMinor - f.salesTaxMinor) - (f.refundsTotalMinor - f.refundsTaxMinor)), description: "Sales less refunds" });
  L.push({ account: "gst_collected", amountMinor: -(f.salesTaxMinor - f.refundsTaxMinor), description: "GST on sales less refunds" });
  L.push({ account: "rounding", amountMinor: -f.roundingMinor, description: "Cash rounding" });
  L.push({ account: "cash_over_short", amountMinor: -f.varianceMinor, description: f.varianceMinor < 0 ? "Drawer short" : "Drawer over" }); L.push({ account: "cash", amountMinor: f.varianceMinor, description: "Drawer count difference" });
  const cogs = f.cogsMinor - f.cogsReturnedMinor; L.push({ account: "cogs", amountMinor: cogs, description: "Cost of goods sold" }); L.push({ account: "inventory", amountMinor: -cogs, description: "Stock sold" });
  let lines = merge(L); const off = sum(lines); if (off !== 0) lines = merge([...lines, { account: "suspense", amountMinor: -off, description: "Payments do not match sales" }]);
  return { lines, unreconciledMinor: off };
}

/** What changed since the lines already sent, account by account. Nothing to send means nothing changed. A change is sent as a small adjusting journal, never by rewriting the first. */
export function delta(sent: Line[][], now: Line[]): Line[] {
  const have = new Map<AccountKey, number>(); for (const ls of sent) for (const l of ls) have.set(l.account, (have.get(l.account) ?? 0) + l.amountMinor);
  const out: Line[] = []; const keys = new Set<AccountKey>([...have.keys(), ...now.map((l) => l.account)]);
  for (const k of keys) { const want = now.find((l) => l.account === k)?.amountMinor ?? 0; const d = want - (have.get(k) ?? 0); if (d !== 0) out.push({ account: k, amountMinor: d, description: now.find((l) => l.account === k)?.description ?? ACCOUNT_LABEL[k] }); }
  return out;
}
export const checksum = (ls: Line[]) => createHash("sha256").update(JSON.stringify([...ls].sort((a, b) => (a.account < b.account ? -1 : 1)).map((l) => [l.account, l.amountMinor]))).digest("hex");
export const reference = (locationCode: string, date: string, version: number) => `SHELFLINE-${locationCode.toUpperCase()}-${date}${version > 1 ? `-ADJ${version}` : ""}`;
export const major = (m: number) => (m / 100).toFixed(2);

const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** Xero's manual journal import file: one row per line, the journal's narration and date on each row, debits positive and credits negative, no tax rate (GST is its own line). */
export function xeroCsv(o: { narration: string; date: string; lines: { code: string; name?: string | null; description: string; amountMinor: number }[] }): string {
  const [y, m, d] = o.date.split("-"); const date = `${d}/${m}/${y}`;
  return ["*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1", ...o.lines.map((l) => [q(o.narration), date, q(l.description), q(l.code), "Tax Exempt", major(l.amountMinor), "", ""].join(","))].join("\n") + "\n";
}
