const f = new Intl.NumberFormat("en-US", { style: "currency", currency: "AUD" });
export const money = (minor: number | null | undefined) => (minor === null || minor === undefined ? "—" : f.format(minor / 100));
export const plain = (minor: number) => (minor < 0 ? "−" : "") + (Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const time = (iso: string | Date | null | undefined, tz?: string) => (iso ? new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }) : "—");
export const dateTime = (iso: string | Date | null | undefined, tz?: string) => (iso ? new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }) : "—");
export const ago = (iso: string | Date | null | undefined) => { if (!iso) return "never"; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const todayYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (ymd: string, n: number) => { const [y, m, d] = ymd.split("-").map(Number); const x = new Date(Date.UTC(y!, m! - 1, d! + n)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`; };
export const FLAG_LABEL: Record<string, string> = {
  card_unverified: "Card payment not confirmed by the terminal",
  price_book_mismatch: "Priced from an older price book", promo_mismatch: "Promotion differs from server", gift_card_overdraft: "Gift card or credit overspent", gift_card_unknown: "Gift card not found", gift_card_void: "Cancelled gift card used", gift_card_expired: "Expired gift card used", store_credit_no_customer: "Store credit without a customer", refund_credit_no_customer: "Credit refund without a customer",
  negative_stock: "Stock below zero", price_mismatch: "Totals differ from server", payment_mismatch: "Payments do not match", discount_unapproved: "Discount without approval", late_sale: "Arrived after close", no_session: "No register session",
  receipt_no_reused: "Receipt number reused", unknown_customer: "Customer not found", skewed_clock: "Till clock off", merge_candidate: "Possible duplicate customer", session_force_closed: "Older session force-closed", no_tax_rate: "No tax rate",
  variance_over_limit: "Cash count off", over_refund: "Over-refund", refund_unapproved: "Refund without approval", refund_amount_mismatch: "Refund amount differs", refund_total_mismatch: "Refund total differs",
  no_sale_no_reason: "No-sale without a reason", pay_out_no_reason: "Pay-out without a reason", late_movement: "Cash entry after close", late_refund: "Refund after close", punch_repeat: "Repeated clock punch", needs_review: "Needs review", variance_approved: "Count approved",
};
export const flagLabel = (f: string) => FLAG_LABEL[f] ?? f.replace(/_/g, " ");

/** "12.50" -> 1250. Whole dollars or up to two decimals; anything else is not an amount. */
export const parseMoney = (s: string): number | null => { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null; };
export const centsText = (minor: number) => (minor / 100).toFixed(2);
