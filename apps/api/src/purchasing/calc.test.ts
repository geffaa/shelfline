import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bucketOf, holdReasons, landedCosts, matchLine } from "./calc";

describe("landed cost", () => {
  it("spreads freight by line value so the shares add up exactly, and raises the unit cost", () => {
    const r = landedCosts([{ qty: 40, unitCostMinor: 5000 }, { qty: 10, unitCostMinor: 10000 }], 3001);   // values 200000 and 100000
    expect(r.map((x) => x.allocMinor)).toEqual([2001, 1000]); expect(r.reduce((a, x) => a + x.allocMinor, 0)).toBe(3001);
    expect(r[0]!.landedUnitCostMinor).toBe(5050); expect(r[1]!.landedUnitCostMinor).toBe(10100);          // (200000+2001)/40 = 5050.025 ; (100000+1000)/10
  });
  it("no extra cost leaves the unit cost alone; free goods share by quantity", () => {
    expect(landedCosts([{ qty: 3, unitCostMinor: 1234 }], 0)).toEqual([{ allocMinor: 0, landedUnitCostMinor: 1234 }]);
    expect(landedCosts([{ qty: 1, unitCostMinor: 0 }, { qty: 3, unitCostMinor: 0 }], 400).map((x) => x.allocMinor)).toEqual([100, 300]);
  });
  it("property: shares always sum to the extra and no unit cost falls below the supplier's", () => {
    fc.assert(fc.property(fc.array(fc.record({ qty: fc.integer({ min: 1, max: 500 }), unitCostMinor: fc.integer({ min: 0, max: 100_000 }) }), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 5_000_000 }), (lines, extra) => {
      const r = landedCosts(lines, extra); expect(r.reduce((a, x) => a + x.allocMinor, 0)).toBe(extra);
      r.forEach((x, i) => { expect(x.landedUnitCostMinor).toBeGreaterThanOrEqual(lines[i]!.unitCostMinor); expect(Math.abs(x.landedUnitCostMinor * lines[i]!.qty - (lines[i]!.qty * lines[i]!.unitCostMinor + x.allocMinor))).toBeLessThanOrEqual(lines[i]!.qty / 2 + 0.5); });
    }));
  });
});

describe("three-way match", () => {
  it("60 billed against 40 received is over-billed by 20", () => {
    expect(matchLine({ billedQty: 60, billedQtyBefore: 0, receivedQty: 40, billedUnitMinor: 5000, orderedUnitMinor: 5000 })).toEqual({ billedQtyToDate: 60, qtyDiff: 20, costDiffMinor: 0, status: "over_billed" });
  });
  it("counts what earlier bills already claimed, and a dearer price on its own is a price variance", () => {
    expect(matchLine({ billedQty: 30, billedQtyBefore: 30, receivedQty: 60, billedUnitMinor: 5000, orderedUnitMinor: 5000 }).status).toBe("ok");
    expect(matchLine({ billedQty: 31, billedQtyBefore: 30, receivedQty: 60, billedUnitMinor: 5000, orderedUnitMinor: 5000 })).toMatchObject({ qtyDiff: 1, status: "over_billed" });   // one unit too many is enough
    expect(matchLine({ billedQty: 10, billedQtyBefore: 0, receivedQty: 10, billedUnitMinor: 5100, orderedUnitMinor: 5000 })).toMatchObject({ status: "price_variance", costDiffMinor: 1000 });
    expect(matchLine({ billedQty: 10, billedQtyBefore: 0, receivedQty: 5, billedUnitMinor: 5100, orderedUnitMinor: 5000 }).status).toBe("both");
    expect(holdReasons([{ status: "ok" }, { status: "both" }])).toEqual(["over_billed", "price_variance"]); expect(holdReasons([{ status: "ok" }])).toEqual([]);
  });
});

describe("aging buckets", () => {
  it("puts days past due in the right bucket, edges included", () => {
    const b = (d: string) => bucketOf(d, "2026-11-30");
    expect([b("2026-12-05"), b("2026-11-30"), b("2026-11-29"), b("2026-10-31"), b("2026-10-30"), b("2026-10-01"), b("2026-09-01"), b("2026-08-31")]).toEqual(["current", "current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d90plus"]);
  });
});
