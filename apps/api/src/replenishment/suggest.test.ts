import { describe, expect, it } from "vitest";
import { rank, suggest, type Position } from "./suggest";

const pos = (o: Partial<Position> = {}): Position => ({ variantId: "v", sku: "SKU", title: "Shoe", onHand: 10, incoming: 0, soldUnits: 60, lookbackDays: 30, leadTimeDays: 7, supplierId: "s1", unitCostMinor: 5000, ...o });
const plan = { safetyDays: 3, reviewDays: 14 };

describe("when to reorder, and how much", () => {
  it("orders when stock and what is coming will not last the lead time plus the safety margin", () => {
    // 2 a day: reorder point 2 x (7+3) = 20, target 2 x (7+3+14) = 48
    expect(suggest(pos({ onHand: 21 }), plan)).toBeNull(); expect(suggest(pos({ onHand: 20 }), plan)).toMatchObject({ reorderPoint: 20, target: 48, qty: 28, reason: "below_reorder_point" }); expect(suggest(pos({ onHand: 5 }), plan)!.qty).toBe(43); expect(suggest(pos({ onHand: 0 }), plan)).toMatchObject({ qty: 48, reason: "out_of_stock", daysCover: 0 });
  });
  it("counts what is already on order, and negative stock as nothing in hand", () => {
    expect(suggest(pos({ onHand: 4, incoming: 30 }), plan)).toBeNull(); expect(suggest(pos({ onHand: 4, incoming: 10 }), plan)!.qty).toBe(34); expect(suggest(pos({ onHand: -6 }), plan)).toMatchObject({ qty: 54, reason: "out_of_stock", daysCover: 0 });
  });
  it("leaves alone what has not sold, and anything with a nonsense window", () => { expect(suggest(pos({ soldUnits: 0, onHand: 0 }), plan)).toBeNull(); expect(suggest(pos({ lookbackDays: 0 }), plan)).toBeNull(); });
  it("a slower seller needs less, a longer lead time needs more, and orders are rounded up to the supplier's multiple", () => {
    expect(suggest(pos({ soldUnits: 3, onHand: 0 }), plan)!.qty).toBe(3); expect(suggest(pos({ onHand: 0, leadTimeDays: 21 }), plan)!.qty).toBe(76); expect(suggest(pos({ onHand: 0, minOrderQty: 12 }), plan)!.qty).toBe(48); expect(suggest(pos({ onHand: 5, minOrderQty: 12 }), plan)!.qty).toBe(48);
  });
  it("never suggests a non-positive quantity, and the order always lifts the position to at least the target", () => {
    let seed = 4; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 4000; i++) { const p = pos({ onHand: Math.floor(rnd() * 80) - 10, incoming: Math.floor(rnd() * 40), soldUnits: Math.floor(rnd() * 200), lookbackDays: 1 + Math.floor(rnd() * 60), leadTimeDays: Math.floor(rnd() * 30), minOrderQty: 1 + Math.floor(rnd() * 12) }); const pl = { safetyDays: Math.floor(rnd() * 10), reviewDays: Math.floor(rnd() * 30) }; const s = suggest(p, pl);
      if (!s) continue; expect(s.qty).toBeGreaterThan(0); expect(s.qty % (p.minOrderQty ?? 1)).toBe(0); expect(p.onHand + p.incoming + s.qty).toBeGreaterThanOrEqual(s.target); expect(p.onHand + p.incoming).toBeLessThanOrEqual(s.reorderPoint); }
  });
  it("the most urgent come first: out of stock, then the least cover", () => {
    const a = suggest(pos({ sku: "A", onHand: 15 }), plan)!, b = suggest(pos({ sku: "B", onHand: 3 }), plan)!, c = suggest(pos({ sku: "C", onHand: 0 }), plan)!, d = suggest(pos({ sku: "D", onHand: -1 }), plan)!; expect(rank([a, b, c, d]).map((x) => x.sku)).toEqual(["C", "D", "B", "A"]);
  });
});
