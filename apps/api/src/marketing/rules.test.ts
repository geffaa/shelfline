import { describe, expect, it } from "vitest";
import { clawbackFor, matchSegment, pointsFor, render, sendBlock, tierFor, type Facts, type Rules } from "./rules";

const NOW = new Date("2026-11-10T00:00:00Z"); const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const facts = (o: Partial<Facts> = {}): Facts => ({ orders: 3, spentMinor: 30000, lastPurchaseAt: daysAgo(10), locationIds: ["L1"], tier: "Member", birthMonth: 11, ...o });

describe("who is in a segment", () => {
  it("an empty rule is everyone; every stated condition must hold", () => {
    expect(matchSegment({}, facts(), NOW)).toBe(true); expect(matchSegment({}, facts({ orders: 0, lastPurchaseAt: null }), NOW)).toBe(true);
    const r: Rules = { minOrders: 2, minSpentMinor: 20000, tiers: ["Member", "Silver"] }; expect(matchSegment(r, facts(), NOW)).toBe(true); expect(matchSegment(r, facts({ orders: 1 }), NOW)).toBe(false); expect(matchSegment(r, facts({ spentMinor: 19999 }), NOW)).toBe(false); expect(matchSegment(r, facts({ tier: "Gold" }), NOW)).toBe(false);
  });
  it("lapsed means the last purchase was at least that many whole days ago, and someone who never bought is not lapsed", () => {
    const lapsed: Rules = { lastPurchaseBeforeDays: 90 }; expect(matchSegment(lapsed, facts({ lastPurchaseAt: daysAgo(90) }), NOW)).toBe(true); expect(matchSegment(lapsed, facts({ lastPurchaseAt: daysAgo(89) }), NOW)).toBe(false);
    expect(matchSegment(lapsed, facts({ orders: 0, lastPurchaseAt: null }), NOW)).toBe(false); const recent: Rules = { lastPurchaseWithinDays: 30 }; expect(matchSegment(recent, facts({ lastPurchaseAt: daysAgo(30) }), NOW)).toBe(true); expect(matchSegment(recent, facts({ lastPurchaseAt: daysAgo(31) }), NOW)).toBe(false); expect(matchSegment(recent, facts({ lastPurchaseAt: null }), NOW)).toBe(false);
    expect(matchSegment({ neverPurchased: true }, facts({ orders: 0, lastPurchaseAt: null }), NOW)).toBe(true); expect(matchSegment({ neverPurchased: true }, facts(), NOW)).toBe(false);
  });
  it("stores, birthday month and order counts", () => {
    expect(matchSegment({ locationIds: ["L2", "L1"] }, facts(), NOW)).toBe(true); expect(matchSegment({ locationIds: ["L2"] }, facts(), NOW)).toBe(false); expect(matchSegment({ birthdayMonth: 11 }, facts(), NOW)).toBe(true); expect(matchSegment({ birthdayMonth: 12 }, facts(), NOW)).toBe(false); expect(matchSegment({ birthdayMonth: 11 }, facts({ birthMonth: null }), NOW)).toBe(false);
    expect(matchSegment({ maxOrders: 3 }, facts(), NOW)).toBe(true); expect(matchSegment({ maxOrders: 2 }, facts(), NOW)).toBe(false);
  });
});

describe("who may be sent a marketing email", () => {
  const base = { email: "a@b.co", consentEmail: true as boolean | undefined, lastMarketingAt: null as Date | null, minGapDays: 7, now: NOW };
  it("only someone who said yes, with an email address", () => {
    expect(sendBlock(base)).toBeNull(); expect(sendBlock({ ...base, consentEmail: false })).toBe("no_consent"); expect(sendBlock({ ...base, consentEmail: undefined })).toBe("no_consent"); expect(sendBlock({ ...base, email: null })).toBe("no_email"); expect(sendBlock({ ...base, email: "nope" })).toBe("no_email");
  });
  it("consent is never overridden: without it nothing else makes a send possible, and it is judged before the frequency cap", () => {
    for (const lastMarketingAt of [null, daysAgo(1), daysAgo(400)]) for (const minGapDays of [0, 7, 90]) expect(sendBlock({ ...base, consentEmail: false, lastMarketingAt, minGapDays })).toBe("no_consent");
    expect(sendBlock({ ...base, consentEmail: false, lastMarketingAt: daysAgo(1) })).toBe("no_consent");
  });
  it("one marketing email per gap: held back inside it, free at exactly the gap, and a gap of zero means no cap", () => {
    expect(sendBlock({ ...base, lastMarketingAt: daysAgo(6) })).toBe("frequency"); expect(sendBlock({ ...base, lastMarketingAt: daysAgo(7) })).toBeNull(); expect(sendBlock({ ...base, lastMarketingAt: daysAgo(1), minGapDays: 0 })).toBeNull();
  });
});

describe("templates and tiers", () => {
  it("fills the placeholders and leaves unknown ones alone", () => { expect(render("Hi {{first_name}} ({{ name }}), {{points}} points, {{tier}}. {{other}}", { name: "Ana Maria Lopez", points: 120, tier: "Silver" })).toBe("Hi Ana (Ana Maria Lopez), 120 points, Silver. {{other}}"); expect(render("{{points}}", { name: "A" })).toBe("0"); });
  const tiers = [{ name: "Gold", min: 1500, multBp: 15000 }, { name: "Member", min: 0, multBp: 10000 }, { name: "Silver", min: 500, multBp: 12500 }];
  it("the highest tier reached, whatever order they were saved in", () => { for (const [pts, name] of [[0, "Member"], [499, "Member"], [500, "Silver"], [1499, "Silver"], [1500, "Gold"], [99999, "Gold"]] as const) expect([pts, tierFor(pts, tiers).name]).toEqual([pts, name]); });
});

describe("points", () => {
  it("whole points per dollar of the sale without GST, with the tier's multiplier, rounded down", () => {
    expect(pointsFor(19995, 1, 10000)).toBe(199); expect(pointsFor(19995, 2, 10000)).toBe(399); expect(pointsFor(19995, 1, 12500)).toBe(249); expect(pointsFor(19995, 1, 15000)).toBe(299); expect(pointsFor(99, 1, 10000)).toBe(0); expect(pointsFor(0, 1, 10000)).toBe(0); expect(pointsFor(-500, 1, 10000)).toBe(0); expect(pointsFor(5000, 0, 10000)).toBe(0);
  });
  it("a refund takes back its share, a full refund takes back exactly what is left, and never more than was earned", () => {
    expect(clawbackFor({ earned: 199, alreadyBack: 0, refundNetMinor: 5000, saleNetMinor: 20000, fullyRefunded: false })).toBe(50); expect(clawbackFor({ earned: 199, alreadyBack: 50, refundNetMinor: 15000, saleNetMinor: 20000, fullyRefunded: true })).toBe(149);
    expect(clawbackFor({ earned: 10, alreadyBack: 9, refundNetMinor: 20000, saleNetMinor: 20000, fullyRefunded: false })).toBe(1); expect(clawbackFor({ earned: 0, alreadyBack: 0, refundNetMinor: 100, saleNetMinor: 100, fullyRefunded: true })).toBe(0);
  });
  it("however a sale is refunded in pieces, earning plus all clawbacks ends at exactly zero", () => {
    let seed = 5; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 2000; i++) { const sale = 100 + Math.floor(rnd() * 100000); const earned = pointsFor(sale, 1 + Math.floor(rnd() * 3), [10000, 12500, 15000][Math.floor(rnd() * 3)]!); let left = sale, back = 0; while (left > 0) { const part = Math.min(left, 1 + Math.floor(rnd() * left)); left -= part; back += clawbackFor({ earned, alreadyBack: back, refundNetMinor: part, saleNetMinor: sale, fullyRefunded: left === 0 }); } expect(earned - back).toBe(0); }
  });
});
