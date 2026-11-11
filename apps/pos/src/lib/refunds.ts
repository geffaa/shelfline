import { SCHEMA_V, RefundCreate, type REFUND_REASONS } from "@shelfline/contracts";
import { refundAmount, type RefundableLine } from "@shelfline/pricing";
import { uuidv7, type LocalStore } from "@shelfline/sync-client";
import type { LocalRefund } from "./cash";
import type { LocalSale } from "./sales";

export type RefundReason = (typeof REFUND_REASONS)[number];
export interface RefundLineView extends RefundableLine { lineNo: number; variantId: string; title: string; optionsLabel: string }
export interface RefundableSale { id: string; receiptNo: string; at: string; cashierName: string; customerName: string | null; totalMinor: number; sessionId?: string | null; lines: RefundLineView[]; payments: { tender: string; amountMinor: number }[]; fromServer: boolean }

/** A sale made on this till, as the refund screen sees it. Refund progress is tracked on the local record so offline refunds add up correctly. */
export function fromLocal(s: LocalSale): RefundableSale {
  return { id: s.id, receiptNo: s.receiptNo, at: s.at, cashierName: s.cashierName, customerName: s.customerName, totalMinor: s.totals.totalMinor, sessionId: s.sessionId, fromServer: false, payments: s.payments.map((p) => ({ tender: p.tender, amountMinor: p.amountMinor })),
    lines: s.lines.map((l, i) => ({ lineNo: l.lineNo ?? i, variantId: l.variantId ?? "", title: l.title, optionsLabel: l.optionsLabel, qty: l.qty, refundedQty: l.refundedQty ?? 0, totalMinor: l.totalMinor, refundedMinor: l.refundedMinor ?? 0, taxMinor: l.taxMinor ?? 0, refundedTaxMinor: l.refundedTaxMinor ?? 0 })) };
}
export const maxRefundable = (l: RefundableLine) => Math.max(0, l.qty - l.refundedQty);

export interface Pick { lineNo: number; qty: number; restock: boolean }
export function planRefund(sale: RefundableSale, picks: Pick[]) {
  const lines = picks.filter((p) => p.qty > 0).map((p) => {
    const l = sale.lines.find((x) => x.lineNo === p.lineNo); if (!l) throw new RangeError(`no line ${p.lineNo}`);
    if (p.qty > maxRefundable(l)) throw new RangeError("more than was sold");
    return { l, ...p, ...refundAmount(l, p.qty) };
  });
  return { lines, totalMinor: lines.reduce((a, x) => a + x.amountMinor, 0), taxMinor: lines.reduce((a, x) => a + x.taxMinor, 0) };
}

export async function completeRefund(store: LocalStore, a: { sale: RefundableSale; picks: Pick[]; tender: "cash" | "card" | "other" | "store_credit"; reason: RefundReason; sessionId: string; cashierId: string; approvalToken?: string; now?: Date }): Promise<LocalRefund> {
  const now = a.now ?? new Date(); const plan = planRefund(a.sale, a.picks);
  if (plan.lines.length === 0) throw new RangeError("nothing to refund");
  const id = uuidv7(now.getTime());
  const payload = RefundCreate.parse({ refundId: id, saleId: a.sale.id, sessionId: a.sessionId, tender: a.tender, reason: a.reason, totalMinor: plan.totalMinor, ...(a.approvalToken ? { approvalToken: a.approvalToken } : {}),
    lines: plan.lines.map((x) => ({ saleLineNo: x.l.lineNo, qty: x.qty, amountMinor: x.amountMinor, taxMinor: x.taxMinor, restock: x.restock })) });
  const rec: LocalRefund = { id, saleId: a.sale.id, receiptNo: a.sale.receiptNo, sessionId: a.sessionId, tender: a.tender, totalMinor: plan.totalMinor, taxMinor: plan.taxMinor, reason: a.reason, at: now.toISOString(), lines: plan.lines.map((x) => ({ title: x.l.title, qty: x.qty, amountMinor: x.amountMinor })) };
  await store.transact(async (tx) => {
    await tx.put("refunds", id, rec);
    const local = await tx.get<LocalSale>("sales", a.sale.id);
    if (local) {
      for (const x of plan.lines) { const ln = local.lines.find((l, i) => (l.lineNo ?? i) === x.l.lineNo); if (ln) { ln.refundedQty = (ln.refundedQty ?? 0) + x.qty; ln.refundedMinor = (ln.refundedMinor ?? 0) + x.amountMinor; ln.refundedTaxMinor = (ln.refundedTaxMinor ?? 0) + x.taxMinor; } }
      await tx.put("sales", a.sale.id, local);
    }
    await tx.enqueue({ type: "refund.create", payload, actorId: a.cashierId, clientTs: now.toISOString(), schemaV: SCHEMA_V });
  });
  return rec;
}
