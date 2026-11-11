import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocate, cashRound, percentBp, taxFromInclusive, divRound } from "./index";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("allocate (property)", () => {
  const weights = fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0));
  it("parts always sum exactly to the total, never lose a cent (10,000 cases)", () => {
    fc.assert(fc.property(fc.integer({ min: -50_000_000, max: 50_000_000 }), weights, (total, w) => {
      expect(sum(allocate(total, w))).toBe(total);
    }), { numRuns: 10_000 });
  });
  it("each part is within 1 minor unit of its exact proportional share", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), weights, (total, w) => {
      const sw = sum(w);
      allocate(total, w).forEach((p, i) => expect(Math.abs(p - (total * w[i]!) / sw)).toBeLessThan(1));
    }), { numRuns: 5_000 });
  });
  it("zero weight gets zero; negative total mirrors positive", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), weights, (total, w) => {
      const pos = allocate(total, w);
      w.forEach((x, i) => { if (x === 0) expect(pos[i]).toBe(0); });
      expect(allocate(-total, w)).toEqual(pos.map((x) => (x === 0 ? 0 : -x)));
    }), { numRuns: 3_000 });
  });
  it("golden: 100 across 3 equal weights", () => { expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]); });
  it("golden: remainder goes to the larger fraction, then the larger weight", () => { expect(allocate(10, [1, 2])).toEqual([3, 7]); });
  it("rejects bad input", () => {
    expect(() => allocate(1.5, [1])).toThrow(); expect(() => allocate(1, [])).toThrow();
    expect(() => allocate(1, [0, 0])).toThrow(); expect(() => allocate(1, [-1, 2])).toThrow();
  });
});

describe("tax and percent", () => {
  it("GST-inclusive A$368.05 contains A$33.46 at 10% (sample in SCREENS S03)", () => { expect(taxFromInclusive(36805, 1000)).toBe(3346); });
  it("commission golden: 4% of A$219.95 ex-GST = A$8.00 (SCREENS/PRD F23)", () => {
    const exGst = 21995 - taxFromInclusive(21995, 1000); // 19995
    expect(exGst).toBe(19995);
    expect(percentBp(exGst, 400)).toBe(800);
  });
  it("half rounds away from zero both ways", () => { expect(percentBp(25, 2000)).toBe(5); expect(percentBp(-25, 2000)).toBe(-5); expect(divRound(5n, 2n)).toBe(3n); expect(divRound(-5n, 2n)).toBe(-3n); });
  it("cash rounding to 5c", () => { expect(cashRound(36803)).toBe(36805); expect(cashRound(36802)).toBe(36800); expect(cashRound(36807)).toBe(36805); expect(cashRound(36808)).toBe(36810); });
});
