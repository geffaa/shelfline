import { EscPos } from "./escpos";

export interface ReceiptData {
  org: string; location: string; register: string; receiptNo: string; at: string; cashier: string; copy: number; columns: number; footer?: string;
  lines: { title: string; options?: string; qty: number; unitMinor: number; discountMinor: number; totalMinor: number }[];
  subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; roundingMinor: number;
  payments: { tender: string; amountMinor: number; changeMinor: number; reference?: string | null }[];
}
const money = (m: number) => `${m < 0 ? "-" : ""}${(Math.abs(m) / 100).toFixed(2)}`;
/** Label on the left, figure on the right, filled to the paper width. If they do not fit, the label is cut and the figure kept. */
export function pair(left: string, right: string, width: number) { const room = Math.max(1, width - right.length - 1); const l = left.length > room ? left.slice(0, room) : left; return l + " ".repeat(Math.max(1, width - l.length - right.length)) + right; }
export function wrap(s: string, width: number): string[] { const out: string[] = []; let cur = ""; for (const w of s.split(/\s+/).filter(Boolean)) { if ((cur + " " + w).trim().length > width) { if (cur) out.push(cur); cur = w.length > width ? w.slice(0, width) : w; } else cur = (cur + " " + w).trim(); } if (cur) out.push(cur); return out.length ? out : [""]; }
const TENDER: Record<string, string> = { cash: "Cash", card: "Card", gift_card: "Gift card", store_credit: "Store credit", other: "Other" };

/** The receipt as printer bytes. Pure: the same sale always gives the same bytes. A reprint says COPY so it cannot pass as an original. */
export function renderReceipt(r: ReceiptData): Uint8Array {
  const w = r.columns; const p = new EscPos().init(); const rule = "-".repeat(w);
  p.align("center").bold(true).big(true).line(r.org.length > w / 2 ? r.org.slice(0, Math.floor(w / 2)) : r.org).big(false).bold(false).line(r.location).line(`${r.register}  ${r.at}`).line(`Served by ${r.cashier}`);
  if (r.copy > 1) p.bold(true).line(`*** COPY ${r.copy} ***`).bold(false);
  p.align("left").line(rule);
  for (const l of r.lines) {
    const title = wrap(l.title, w - 10); p.line(pair(`${l.qty} x ${title[0]}`, money(l.totalMinor + l.discountMinor), w)); for (const t of title.slice(1)) p.line(`    ${t}`);
    if (l.options) for (const o of wrap(l.options, w - 4)) p.line(`    ${o}`); if (l.discountMinor > 0) p.line(pair("    Discount", money(-l.discountMinor), w));
  }
  p.line(rule).line(pair("Subtotal", money(r.subtotalMinor), w)); if (r.discountMinor > 0) p.line(pair("Discounts", money(-r.discountMinor), w)); if (r.roundingMinor !== 0) p.line(pair("Rounding", money(r.roundingMinor), w));
  p.bold(true).big(true).line(pair("TOTAL", money(r.totalMinor + r.roundingMinor), Math.floor(w / 2))).big(false).bold(false);
  for (const x of r.payments) { p.line(pair(`${TENDER[x.tender] ?? x.tender}${x.reference ? ` ${x.reference}` : ""}`, money(x.amountMinor), w)); if (x.changeMinor > 0) p.line(pair("  Change", money(x.changeMinor), w)); }
  p.line(pair("GST included", money(r.taxMinor), w)).line(rule).align("center").line(`Receipt ${r.receiptNo}`).barcode(r.receiptNo);
  if (r.footer) for (const f of wrap(r.footer, w)) p.line(f);
  return p.feedLines(3).cut().bytes();
}
export const drawerBytes = () => new EscPos().init().drawer().bytes();
export function testPage(name: string, columns: number): Uint8Array {
  const p = new EscPos().init().align("center").bold(true).line("Shelfline test print").bold(false).line(name).align("left").line("-".repeat(columns)).line("0123456789".repeat(Math.ceil(columns / 10)).slice(0, columns)).line(pair("Left", "Right", columns)).line("Accents: café, señor, naïve").line("-".repeat(columns));
  return p.feedLines(3).cut().bytes();
}
