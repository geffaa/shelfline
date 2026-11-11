import { divRound, type Minor } from "@shelfline/money";

/**
 * Pricing v2: which price a variant sells at (price books) and which promotions take money off a line.
 * Pure functions: the till runs them offline on the replicated books, the server runs the same code to check what the till did,
 * and the same golden vectors (written by an independent Python reference) gate both.
 * Books and promotions arrive already limited to the location; dates are the location's business date (YYYY-MM-DD, inclusive).
 */
export interface BookView { id: string; priority: number; validFrom: string | null; validTo: string | null; prices: Record<string, Minor> }
export interface ResolvedPrice { unitPriceMinor: Minor; priceBookId: string | null }

const inWindow = (from: string | null, to: string | null, on: string) => (!from || from <= on) && (!to || to >= on);

/** The highest-priority book that is in force on the date and lists the variant wins; equal priorities fall to the smaller book id. No book: the variant's base price. */
export function resolvePrice(variantId: string, basePriceMinor: Minor, onDate: string, books: BookView[]): ResolvedPrice {
  let best: BookView | null = null;
  for (const b of books) {
    if (!inWindow(b.validFrom, b.validTo, onDate) || !(variantId in b.prices)) continue;
    if (!best || b.priority > best.priority || (b.priority === best.priority && b.id < best.id)) best = b;
  }
  return best ? { unitPriceMinor: best.prices[variantId]!, priceBookId: best.id } : { unitPriceMinor: basePriceMinor, priceBookId: null };
}

export interface PromoView { id: string; kind: "percent" | "amount_off"; valueBp: number; amountMinor: Minor; variantIds: string[] | null; minQty: number; validFrom: string | null; validTo: string | null; stackable: boolean }
export interface PromoLine { variantId: string; unitPriceMinor: Minor; qty: number }
export interface PromoResult { discountMinor: Minor; promotionIds: string[] }

/**
 * Per line: every promotion in force whose variants and minimum quantity fit is a candidate.
 * Percent takes valueBp of the line value (half up); amount_off takes amountMinor per unit.
 * Of the non-stackable candidates only the biggest applies (ties to the smaller id); every stackable one is added; the total never exceeds the line value.
 */
export function applyPromotions(lines: PromoLine[], promos: PromoView[], onDate: string): PromoResult[] {
  return lines.map((l) => {
    const value = l.unitPriceMinor * l.qty; let bestSolo: { id: string; d: number } | null = null; let stacked = 0; const stackIds: string[] = [];
    for (const p of promos) {
      if (!inWindow(p.validFrom, p.validTo, onDate) || l.qty < p.minQty || (p.variantIds && !p.variantIds.includes(l.variantId))) continue;
      const d = Math.min(value, p.kind === "percent" ? Number(divRound(BigInt(value) * BigInt(p.valueBp), 10000n)) : p.amountMinor * l.qty);
      if (d <= 0) continue;
      if (p.stackable) { stacked += d; stackIds.push(p.id); } else if (!bestSolo || d > bestSolo.d || (d === bestSolo.d && p.id < bestSolo.id)) bestSolo = { id: p.id, d };
    }
    const ids = [...(bestSolo ? [bestSolo.id] : []), ...stackIds.sort()];
    return { discountMinor: Math.min(value, (bestSolo?.d ?? 0) + stacked), promotionIds: ids };
  });
}
