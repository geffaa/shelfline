import { SALE_TENDERS, SCHEMA_V, SaleCreate } from "@shelfline/contracts";
import type { CartResult } from "@shelfline/pricing";
import { uuidv7, type LocalStore } from "@shelfline/sync-client";
import type { Cart } from "./cart";
import type { VariantView } from "./catalogue";

export type Tender = (typeof SALE_TENDERS)[number];
export interface PaymentInput { tender: Tender; amountMinor: number; tenderedMinor?: number; reference?: string }
export interface LocalSession {
  id: string; openedAt: string; openingFloatMinor: number; cashierId: string; cashierName: string;
  status?: "open" | "closed"; closedAt?: string; countedMinor?: number; provisionalExpectedMinor?: number; provisionalVarianceMinor?: number;
}
export interface LocalSale {
  id: string; receiptNo: string; at: string; cashierName: string; customerName: string | null; registerCode: string; sessionId?: string;
  lines: { lineNo?: number; variantId?: string; title: string; optionsLabel: string; qty: number; unitPriceMinor: number; discountMinor: number; totalMinor: number; taxMinor?: number; refundedQty?: number; refundedMinor?: number; refundedTaxMinor?: number }[];
  totals: { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; roundingMinor: number; payableMinor: number };
  payments: PaymentInput[]; changeMinor: number;
}
export const receiptNo = (registerCode: string, n: number) => `${registerCode}-${String(n).padStart(6, "0")}`;

export interface CompleteArgs {
  cart: Cart; priced: { result: CartResult; discounts: number[]; promos?: { discountMinor: number; promotionIds: string[] }[] }; payments: PaymentInput[]; cashRoundingStep: number | null;
  session: LocalSession; cashier: { id: string; name: string }; register: { id: string; code: string }; customer: { id: string; name: string } | null;
  variants: Map<string, VariantView>; catalogVersion?: number; pricingVersion?: number; now?: () => Date;
}

/**
 * Finishing a sale writes two things in ONE local transaction: the receipt record and the queued command (with the next receipt number).
 * If the tab dies between them, neither exists: there is never a sale without its command or a command without its receipt.
 */
export async function completeSale(store: LocalStore, a: CompleteArgs): Promise<LocalSale> {
  const now = (a.now ?? (() => new Date()))();
  return store.transact(async (tx) => {
    const seqKey = `receiptSeq:${a.register.id}`;
    const n = Number((await tx.getMeta(seqKey)) ?? "0") + 1;
    const no = receiptNo(a.register.code, n);
    const saleId = uuidv7(now.getTime());
    const r = a.priced.result;
    const payload = SaleCreate.parse({
      saleId, sessionId: a.session.id, receiptNo: no, customerId: a.customer?.id ?? null,
      lines: a.cart.lines.map((l, i) => ({ variantId: l.variantId, qty: l.qty, unitPriceMinor: l.unitPriceMinor, discountMinor: a.priced.discounts[i]!, ...(l.priceBookId ? { priceBookId: l.priceBookId } : {}), ...((a.priced.promos?.[i]?.discountMinor ?? 0) > 0 ? { promoDiscountMinor: a.priced.promos![i]!.discountMinor, promotionIds: a.priced.promos![i]!.promotionIds } : {}), ...(l.discountReason ? { discountReason: l.discountReason } : {}), ...(l.approvalToken ? { approvalToken: l.approvalToken } : {}) })),
      payments: a.payments.map((p) => ({ tender: p.tender, amountMinor: p.amountMinor, ...(p.tenderedMinor !== undefined ? { tenderedMinor: p.tenderedMinor } : {}), ...(p.reference ? { reference: p.reference } : {}) })),
      totals: { subtotalMinor: r.subtotalMinor, discountMinor: r.discountMinor, taxMinor: r.taxMinor, totalMinor: r.totalMinor, roundingMinor: r.cashRoundingMinor, payableMinor: r.payableMinor },
      cashRoundingStep: a.cashRoundingStep, ...(a.cart.onlineOrderId ? { onlineOrderId: a.cart.onlineOrderId } : {}), ...(a.catalogVersion !== undefined ? { catalogVersion: a.catalogVersion } : {}), ...(a.pricingVersion !== undefined ? { pricingVersion: a.pricingVersion } : {}),
    });
    const changeMinor = a.payments.reduce((s, p) => s + (p.tender === "cash" && p.tenderedMinor !== undefined ? Math.max(0, p.tenderedMinor - p.amountMinor) : 0), 0);
    const rec: LocalSale = {
      id: saleId, receiptNo: no, at: now.toISOString(), cashierName: a.cashier.name, customerName: a.customer?.name ?? null, registerCode: a.register.code,
      sessionId: a.session.id,
      lines: a.cart.lines.map((l, i) => { const v = a.variants.get(l.variantId); return { lineNo: i, variantId: l.variantId, title: v?.title ?? "Item", optionsLabel: v?.optionsLabel ?? "", qty: l.qty, unitPriceMinor: l.unitPriceMinor, discountMinor: a.priced.discounts[i]!, totalMinor: r.lines[i]!.totalMinor, taxMinor: r.lines[i]!.taxMinor, refundedQty: 0, refundedMinor: 0, refundedTaxMinor: 0 }; }),
      totals: payload.totals, payments: a.payments.map((x) => (x.tender === "gift_card" ? { ...x, reference: `…${(x.reference ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase()}` } : x)), changeMinor,
    };
    await tx.put("sales", saleId, rec);
    await tx.setMeta(seqKey, String(n));
    await tx.enqueue({ type: "sale.create", payload, actorId: a.cashier.id, clientTs: now.toISOString(), schemaV: SCHEMA_V });
    return rec;
  });
}

/** Units sold on this till that the server has not yet acknowledged; subtracted from the replica's stock so the shelf count stays honest offline. */
export async function pendingSold(store: LocalStore): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const c of await store.pendingCommands(5000)) if (c.type === "sale.create") for (const l of (c.payload as { lines: { variantId: string; qty: number }[] }).lines) out.set(l.variantId, (out.get(l.variantId) ?? 0) + l.qty);
  return out;
}
