import { describe, expect, it } from "vitest";
import { baseOf, clawbacks, commissionOf, pickRule, recipients, split, versionOn, type RuleSet, type RuleVersion } from "./engine";

const v = (n: number, from: string, o: Partial<RuleVersion> = {}): RuleVersion => ({ id: `v${n}-${from}`, version: n, validFrom: from, enabled: true, basis: "net_ex_tax", rateBp: 400, splitMode: "seller", weights: {}, ...o });
const set = (kind: RuleSet["scopeKind"], value: string | null, versions: RuleVersion[]): RuleSet => ({ id: `${kind}-${value}`, scopeKind: kind, scopeValue: value, versions });
const scope = { locationId: "L1", categoryId: "C1", brand: "Tempra", variantId: "V1" };

describe("golden: A$219.95 at 4% of the amount without GST", () => {
  it("is A$8.00", () => {
    // 21995 includes 10% GST of 2000 (1999.5 rounded), net 19995, 4% = 799.8
    expect(baseOf("net_ex_tax", { qty: 1, totalMinor: 21995, taxMinor: 2000, unitCostMinor: null })).toBe(19995);
    expect(commissionOf(19995, 400)).toBe(800);
  });
  it("margin is net less cost and never negative; a missing cost is no margin", () => {
    expect(baseOf("margin", { qty: 2, totalMinor: 22000, taxMinor: 2000, unitCostMinor: 7000 })).toBe(6000);
    expect(baseOf("margin", { qty: 1, totalMinor: 3300, taxMinor: 300, unitCostMinor: 5000 })).toBe(0);
    expect(baseOf("margin", { qty: 1, totalMinor: 3300, taxMinor: 300, unitCostMinor: null })).toBe(0);
  });
});

describe("rule choice", () => {
  const sets = [set("default", null, [v(1, "2026-01-01", { rateBp: 200 })]), set("location", "L1", [v(1, "2026-01-01", { rateBp: 300 })]), set("category", "C1", [v(1, "2026-01-01", { rateBp: 350 })]),
    set("brand", "tempra", [v(1, "2026-01-01", { rateBp: 500 })]), set("variant", "V1", [v(1, "2026-03-01", { rateBp: 900 })])];
  it("prefers the narrowest scope and respects the date the version starts", () => {
    expect(pickRule(sets, scope, "2026-02-01")!.rateBp).toBe(500);                                   // variant rule not started yet
    expect(pickRule(sets, scope, "2026-03-01")!.rateBp).toBe(900);
    expect(pickRule(sets, { ...scope, variantId: "V2" }, "2026-03-01")!.rateBp).toBe(500);
    expect(pickRule(sets, { ...scope, variantId: "V2", brand: "Other" }, "2026-03-01")!.rateBp).toBe(350);
    expect(pickRule(sets, { ...scope, variantId: "V2", brand: null, categoryId: null }, "2026-03-01")!.rateBp).toBe(300);
    expect(pickRule(sets, { locationId: "L9", categoryId: null, brand: null, variantId: "V2" }, "2026-03-01")!.rateBp).toBe(200);
    expect(pickRule(sets, scope, "2025-12-31")).toBeNull();
  });
  it("uses the version in force on the date, so old sales keep the old rate", () => {
    const s = set("default", null, [v(1, "2026-01-01", { rateBp: 200 }), v(2, "2026-06-01", { rateBp: 600 })]);
    expect(versionOn(s, "2026-05-31")!.rateBp).toBe(200); expect(versionOn(s, "2026-06-01")!.rateBp).toBe(600);
  });
  it("a switched-off version excludes the scope from the general rate", () => {
    const s = [set("default", null, [v(1, "2026-01-01")]), set("brand", "tempra", [v(1, "2026-01-01", { enabled: false })])];
    expect(pickRule(s, scope, "2026-02-01")).toBeNull(); expect(pickRule(s, { ...scope, brand: "Other" }, "2026-02-01")!.rateBp).toBe(400);
  });
});

describe("who shares a line", () => {
  const ctx = { sellerId: "u-seller", onShift: [{ userId: "u-b", role: "store_manager" }, { userId: "u-a", role: "cashier" }, { userId: "u-seller", role: "cashier" }], minutes: new Map([["u-a", 300], ["u-b", 100], ["u-c", 0]]) };
  it("seller takes it all; equal and weighted use whoever is clocked in; hours pool uses worked minutes", () => {
    expect(recipients("seller", {}, ctx)).toEqual([{ userId: "u-seller", weight: 1 }]);
    expect(recipients("equal", {}, ctx).map((r) => r.userId)).toEqual(["u-a", "u-b", "u-seller"]);
    expect(recipients("weighted", { store_manager: 200, cashier: 100 }, ctx)).toEqual([{ userId: "u-a", weight: 100 }, { userId: "u-b", weight: 200 }, { userId: "u-seller", weight: 100 }]);
    expect(recipients("hours_pool", {}, ctx)).toEqual([{ userId: "u-a", weight: 300 }, { userId: "u-b", weight: 100 }]);
  });
  it("falls back to the seller when nobody can be resolved", () => {
    const none = { sellerId: "s", onShift: [], minutes: new Map() };
    for (const m of ["equal", "weighted", "hours_pool"] as const) expect(recipients(m, {}, none)).toEqual([{ userId: "s", weight: 1 }]);
  });
});

describe("properties", () => {
  const rnd = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  it("the shares always add up to the commission", () => {
    const r = rnd(7);
    for (let i = 0; i < 2000; i++) {
      const amount = Math.floor(r() * 5000); const n = 1 + Math.floor(r() * 5); const parts = Array.from({ length: n }, (_, k) => ({ userId: `u${k}`, weight: 1 + Math.floor(r() * 300) }));
      expect(split(amount, parts).reduce((a, b) => a + b.amountMinor, 0)).toBe(amount);
    }
  });
  it("earn plus the full clawback is exactly zero for every person, however the returns are cut up", () => {
    const r = rnd(11);
    for (let i = 0; i < 2000; i++) {
      const qty = 1 + Math.floor(r() * 9); const base = Math.floor(r() * 90000); const total = commissionOf(base, 1 + Math.floor(r() * 2000));
      const earned = split(total, Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => ({ userId: `u${k}`, weight: 1 + Math.floor(r() * 200) })));
      let left = qty; const refunds: { key: string; qty: number }[] = [];
      while (left > 0) { const q = 1 + Math.floor(r() * left); refunds.push({ key: `r${refunds.length}`, qty: q }); left -= q; }
      const back = clawbacks(earned, qty, refunds); const net = new Map(earned.map((e) => [e.userId, e.amountMinor]));
      for (const rows of back.values()) for (const x of rows) net.set(x.userId, (net.get(x.userId) ?? 0) + x.amountMinor);
      expect([...net.values()].every((x) => x === 0)).toBe(true);
    }
  });
  it("a part refund gives back a proportional part and never more than earned", () => {
    const earned = [{ userId: "a", amountMinor: 1000 }, { userId: "b", amountMinor: 500 }];
    const back = clawbacks(earned, 4, [{ key: "r1", qty: 1 }, { key: "r2", qty: 1 }]);
    expect(back.get("r1")).toEqual([{ userId: "a", amountMinor: -250 }, { userId: "b", amountMinor: -125 }]);
    expect(clawbacks(earned, 2, [{ key: "x", qty: 5 }]).get("x")).toEqual([{ userId: "a", amountMinor: -1000 }, { userId: "b", amountMinor: -500 }]);   // over-refund is capped
  });
});
