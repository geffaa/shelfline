import { percentBp } from "@shelfline/money";
import { priceCart, type CartResult, type PromoLine, type PromoResult, type TaxRule } from "@shelfline/pricing";

export interface CartLine { key: string; variantId: string; qty: number; unitPriceMinor: number; discountBp: number; priceBookId?: string | null; discountReason?: string; approvalToken?: string; approverName?: string }
export interface Cart { lines: CartLine[]; customerId: string | null; /** The online order this sale collects. */ onlineOrderId?: string | null }
export const emptyCart = (): Cart => ({ lines: [], customerId: null });

let counter = 0;
const newKey = () => `l${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Adding a variant that is already in the cart (and has no discount) bumps its quantity: a scan twice is two pairs, not two lines. */
export function addVariant(cart: Cart, v: { id: string; basePriceMinor: number }, qty = 1, price?: { unitPriceMinor: number; priceBookId: string | null }): Cart {
  const i = cart.lines.findIndex((l) => l.variantId === v.id && l.discountBp === 0);
  if (i >= 0) return { ...cart, lines: cart.lines.map((l, j) => (j === i ? { ...l, qty: Math.min(999, l.qty + qty) } : l)) };
  return { ...cart, lines: [...cart.lines, { key: newKey(), variantId: v.id, qty, unitPriceMinor: price?.unitPriceMinor ?? v.basePriceMinor, priceBookId: price?.priceBookId ?? null, discountBp: 0 }] };
}
export const setQty = (cart: Cart, key: string, qty: number): Cart => ({ ...cart, lines: qty <= 0 ? cart.lines.filter((l) => l.key !== key) : cart.lines.map((l) => (l.key === key ? { ...l, qty: Math.min(999, qty) } : l)) });
export const removeLine = (cart: Cart, key: string): Cart => ({ ...cart, lines: cart.lines.filter((l) => l.key !== key) });
export const setCustomer = (cart: Cart, customerId: string | null): Cart => ({ ...cart, customerId });
/** Discounts are a percentage of the line (so they follow quantity changes). 0 clears it and any approval. */
export function setDiscount(cart: Cart, key: string, discountBp: number, reason?: string): Cart {
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) throw new RangeError("discount must be 0-100%");
  return { ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, discountBp, discountReason: discountBp ? reason : undefined, ...(discountBp === 0 ? { approvalToken: undefined, approverName: undefined } : {}) } : l)) };
}
export const approveLine = (cart: Cart, key: string, approvalToken: string, approverName: string): Cart => ({ ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, approvalToken, approverName } : l)) });

export const lineDiscountMinor = (l: CartLine) => (l.discountBp ? percentBp(l.unitPriceMinor * l.qty, l.discountBp) : 0);

/** Lines whose discount is above the cashier's limit and not yet approved. Empty means the sale can be taken. */
export function linesNeedingApproval(cart: Cart, limitBp: number, canApprove: boolean): CartLine[] {
  if (canApprove) return [];
  return cart.lines.filter((l) => l.discountBp > limitBp && !l.approvalToken);
}

/** `discounts` is what is taken off each line in all (the cashier's discount plus promotions); `promos` is the promotion part, which the server checks separately. */
export interface Priced { result: CartResult; discounts: number[]; promos: PromoResult[] }
export function priceOf(cart: Cart, taxRuleFor: (variantId: string) => TaxRule, cashRoundingStep: number | null = null, promoFor?: (lines: PromoLine[]) => PromoResult[]): Priced {
  const promos = promoFor ? promoFor(cart.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor, qty: l.qty }))) : cart.lines.map(() => ({ discountMinor: 0, promotionIds: [] as string[] }));
  const discounts = cart.lines.map((l, i) => Math.min(l.unitPriceMinor * l.qty, promos[i]!.discountMinor + Math.min(lineDiscountMinor(l), l.unitPriceMinor * l.qty - promos[i]!.discountMinor)));
  return { discounts, promos, result: priceCart(cart.lines.map((l, i) => ({ unitPriceMinor: l.unitPriceMinor, qty: l.qty, discountMinor: discounts[i]!, tax: taxRuleFor(l.variantId) })), { cashRoundingStep }) };
}
export const itemCount = (cart: Cart) => cart.lines.reduce((a, l) => a + l.qty, 0);
