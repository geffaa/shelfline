import { describe, expect, it } from "vitest";
import { closeHidden, reportDef } from "./catalog";
import { endedReason, ReportScope, windowOf, type GrantFacts } from "./scope";

const FIT = "11111111-1111-4111-8111-111111111111", SYA = "22222222-2222-4222-8222-222222222222", FRE = "33333333-3333-4333-8333-333333333333";
const grant = (o: Partial<GrantFacts> = {}): GrantFacts => ({ id: "g1", reportKeys: ["sales"], locationIds: [FIT], rangeKind: "fixed", rangeFrom: "2026-10-01", rangeTo: "2026-10-31", rollingDays: null, hiddenColumns: ["costMinor"], expiresAt: null, revokedAt: null, ...o });
const scopeOf = (g = grant(), today = "2026-11-04") => ReportScope.fromGrant(g, "sales", today, new Date("2026-11-04T00:00:00Z"));

describe("the places, the dates and the columns a grant allows", () => {
  it("cuts dates to the window, keeping what overlaps", () => {
    const s = scopeOf();
    expect(s.clamp({})).toMatchObject({ from: "2026-10-01", to: "2026-10-31", locationIds: [FIT], empty: false, clamped: false });
    expect(s.clamp({ from: "2026-09-15", to: "2026-10-10" })).toMatchObject({ from: "2026-10-01", to: "2026-10-10", clamped: true });
    expect(s.clamp({ from: "2026-10-20", to: "2026-12-31" })).toMatchObject({ from: "2026-10-20", to: "2026-10-31", clamped: true });
    expect(s.clamp({ from: "2026-10-05", to: "2026-10-06" })).toMatchObject({ from: "2026-10-05", to: "2026-10-06", clamped: false });
  });
  it("a request wholly outside the window is empty, never widened", () => {
    const s = scopeOf();
    for (const r of [{ from: "2026-11-01", to: "2026-11-30" }, { from: "2026-01-01", to: "2026-09-30" }, { from: "2026-11-01" }, { to: "2026-09-30" }]) expect(s.clamp(r).empty).toBe(true);
  });
  it("refuses a place outside the grant, whatever the dates", () => {
    const s = scopeOf();
    for (const loc of [SYA, FRE]) expect(() => s.clamp({ locationId: loc })).toThrow(); expect(() => s.clamp({ locationId: SYA, from: "2026-10-01", to: "2026-10-02" })).toThrow();
    expect(s.clamp({ locationId: FIT }).locationIds).toEqual([FIT]);
    const two = scopeOf(grant({ locationIds: [FIT, SYA] })); expect(two.clamp({}).locationIds).toEqual([FIT, SYA]); expect(two.clamp({ locationId: SYA }).locationIds).toEqual([SYA]); expect(() => two.clamp({ locationId: FRE })).toThrow();
    expect(scopeOf(grant({ locationIds: null })).clamp({}).locationIds).toBeNull();                       // every place
  });
  it("rejects malformed dates instead of passing them to a query", () => { for (const f of ["2026-10-1", "x", "2026-10-01'; drop table sale;--"]) expect(() => scopeOf().clamp({ from: f })).toThrow(); });
  it("a rolling window ends today and moves with the day", () => {
    const g = grant({ rangeKind: "rolling", rangeFrom: null, rangeTo: null, rollingDays: 30 });
    expect(windowOf(g, "2026-11-04")).toEqual({ from: "2026-10-06", to: "2026-11-04" }); expect(windowOf(g, "2026-11-05")).toEqual({ from: "2026-10-07", to: "2026-11-05" });
    expect(scopeOf(g, "2026-11-04").clamp({ from: "2026-10-01" })).toMatchObject({ from: "2026-10-06", clamped: true });
    expect(windowOf({ ...g, rollingDays: 1 }, "2026-03-01")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
  });
  it("hides what the grant hides, and what would give it away", () => {
    expect([...closeHidden(["costMinor"])].sort()).toEqual(["costMinor", "marginMinor"]); expect([...closeHidden(["marginMinor"])]).toEqual(["marginMinor"]); expect([...closeHidden([])]).toEqual([]);
    const s = scopeOf(); const cols = s.columns(reportDef("sales")!.columns).map((c) => c.key); expect(cols).not.toContain("costMinor"); expect(cols).not.toContain("marginMinor"); expect(cols).toContain("netMinor");
    expect(s.strip([{ label: "a", netMinor: 5, costMinor: 3, marginMinor: 2 }])).toEqual([{ label: "a", netMinor: 5 }]);
    expect(s.sortable("netMinor", "label")).toBe("netMinor"); expect(scopeOf(grant({ hiddenColumns: ["netMinor"] })).sortable("netMinor", "label")).toBe("label");
  });
  it("a grant that has ended or does not cover the report gives no scope at all", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    expect(endedReason(grant({ revokedAt: new Date("2026-11-01") }), now)).toBe("revoked"); expect(endedReason(grant({ expiresAt: new Date("2026-11-03T23:59:59Z") }), now)).toBe("expired");
    expect(endedReason(grant({ expiresAt: new Date("2026-11-04T00:00:01Z") }), now)).toBeNull();
    expect(() => scopeOf(grant({ revokedAt: new Date("2026-11-01") }))).toThrow(); expect(() => ReportScope.fromGrant(grant(), "cash_variance", "2026-11-04", now)).toThrow(); expect(() => ReportScope.fromGrant(grant(), "nope", "2026-11-04", now)).toThrow();
  });
  it("staff are limited to their places and see cost only with the cost permission", () => {
    const s = ReportScope.forStaff([FIT], false); expect(s.hidden.has("costMinor")).toBe(true); expect(s.hidden.has("marginMinor")).toBe(true); expect(() => s.clamp({ locationId: SYA })).toThrow();
    expect(ReportScope.forStaff(null, true).hidden.size).toBe(0);
  });
});
