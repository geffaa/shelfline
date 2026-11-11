/** What we know about one product at one place (or across the network): stock, what is on order, how fast it sells, and how long the supplier takes. */
export interface Position { variantId: string; sku: string; title: string; onHand: number; incoming: number; soldUnits: number; lookbackDays: number; leadTimeDays: number; supplierId: string | null; unitCostMinor: number; minOrderQty?: number }
export interface Plan { safetyDays: number; reviewDays: number }
export interface Suggestion { variantId: string; sku: string; title: string; supplierId: string | null; onHand: number; incoming: number; avgDaily: number; daysCover: number | null; reorderPoint: number; target: number; qty: number; reason: "out_of_stock" | "below_reorder_point"; unitCostMinor: number }

/**
 * Order when what we have and what is coming would not last through the supplier's lead time plus a safety margin, and order enough to last through the lead time,
 * the margin and one more review period. Products that have not sold in the lookback window are left alone: no sales, no demand to plan for.
 * The quantity is rounded up to the supplier's minimum order multiple.
 */
export function suggest(p: Position, plan: Plan): Suggestion | null {
  if (p.lookbackDays <= 0 || p.soldUnits <= 0) return null;
  const avg = p.soldUnits / p.lookbackDays; const reorderPoint = Math.ceil(avg * (p.leadTimeDays + plan.safetyDays) - 1e-9); const target = Math.ceil(avg * (p.leadTimeDays + plan.safetyDays + plan.reviewDays) - 1e-9);
  const position = p.onHand + p.incoming; if (position > reorderPoint) return null;
  let qty = target - position; if (qty <= 0) return null; const m = Math.max(1, p.minOrderQty ?? 1); qty = Math.ceil(qty / m) * m;
  const cover = avg > 0 ? Math.round((Math.max(0, position) / avg) * 10) / 10 : null;
  return { variantId: p.variantId, sku: p.sku, title: p.title, supplierId: p.supplierId, onHand: p.onHand, incoming: p.incoming, avgDaily: Math.round(avg * 100) / 100, daysCover: cover, reorderPoint, target, qty, reason: p.onHand <= 0 ? "out_of_stock" : "below_reorder_point", unitCostMinor: p.unitCostMinor };
}
/** Most urgent first: out of stock, then the fewest days of cover. */
export const rank = (s: Suggestion[]) => [...s].sort((a, b) => (a.reason === b.reason ? (a.daysCover ?? 0) - (b.daysCover ?? 0) : a.reason === "out_of_stock" ? -1 : 1) || a.sku.localeCompare(b.sku));
