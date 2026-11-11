import { describe, expect, it } from "vitest";
import { nextDigest, plan, quietUntil, ruleMatches, type NotifyEvent, type RuleFacts } from "./engine";

const rule = (o: Partial<RuleFacts> = {}): RuleFacts => ({ id: "r", eventKind: "no_sale", locationIds: null, conditions: {}, channels: ["in_app"], quietStart: null, quietEnd: null, critical: false, digest: false, digestAt: "18:00", active: true, ...o });
const ev = (o: Partial<NotifyEvent> = {}): NotifyEvent => ({ kind: "no_sale", ref: "cash:1", locationId: "L1", severity: "info", title: "t", body: "b", facts: {}, ...o });
const MEL = "Australia/Melbourne", PER = "Australia/Perth";

describe("which rules care about an event", () => {
  it("needs the same kind, an active rule and a place the rule covers", () => {
    expect(ruleMatches(rule(), ev())).toBe(true); expect(ruleMatches(rule({ eventKind: "large_refund" }), ev())).toBe(false); expect(ruleMatches(rule({ active: false }), ev())).toBe(false);
    expect(ruleMatches(rule({ locationIds: ["L1", "L2"] }), ev())).toBe(true); expect(ruleMatches(rule({ locationIds: ["L2"] }), ev())).toBe(false); expect(ruleMatches(rule({ locationIds: ["L1"] }), ev({ locationId: null }))).toBe(false);
  });
  it("thresholds are inclusive, except variance, which must go over", () => {
    expect(ruleMatches(rule({ conditions: { minMinor: 5000 } }), ev({ facts: { amountMinor: 5000 } }))).toBe(true); expect(ruleMatches(rule({ conditions: { minMinor: 5000 } }), ev({ facts: { amountMinor: 4999 } }))).toBe(false);
    expect(ruleMatches(rule({ conditions: { minLateMinutes: 10 } }), ev({ facts: { lateMinutes: 10 } }))).toBe(true); expect(ruleMatches(rule({ conditions: { minLateMinutes: 10 } }), ev({ facts: { lateMinutes: 9 } }))).toBe(false);
    for (const [v, ok] of [[500, false], [501, true], [-501, true], [-500, false], [0, false]] as const) expect([v, ruleMatches(rule({ conditions: { varianceOverMinor: 500 } }), ev({ facts: { varianceMinor: v } }))]).toEqual([v, ok]);
  });
});

describe("quiet hours, in the place's own time", () => {
  const at = (iso: string) => new Date(iso);
  it("a window that runs past midnight holds from the start until the end the next morning", () => {
    // Melbourne 2026-11-04 is AEDT (UTC+11): 23:30 local = 12:30Z; 06:59 local next day = 19:59Z
    expect(quietUntil(at("2026-11-04T12:30:00Z"), "22:00", "07:00", MEL)?.toISOString()).toBe("2026-11-04T20:00:00.000Z");        // 07:00 AEDT on the 5th is 20:00Z on the 4th
    expect(quietUntil(at("2026-11-04T19:59:00Z"), "22:00", "07:00", MEL)?.toISOString()).toBe("2026-11-04T20:00:00.000Z");        // 06:59 on the 5th is still quiet, ends in a minute
    expect(quietUntil(at("2026-11-04T20:00:00Z"), "22:00", "07:00", MEL)).toBeNull();                                          // 07:00 sharp is awake
    expect(quietUntil(at("2026-11-04T11:00:00Z"), "22:00", "07:00", MEL)).not.toBeNull();                                      // 22:00 sharp is already quiet (the start is inclusive)
  });
  it("22:00 local is inside, 21:59 is not; a same-day window works; no window means never quiet", () => {
    expect(quietUntil(at("2026-11-04T10:59:00Z"), "22:00", "07:00", MEL)).toBeNull();
    expect(quietUntil(at("2026-11-04T11:00:00Z"), "22:00", "07:00", MEL)).not.toBeNull();
    expect(quietUntil(at("2026-11-04T03:00:00Z"), "12:00", "14:00", MEL)).toBeNull();                                          // 14:00 AEDT is the end itself, already awake
    expect(quietUntil(at("2026-11-04T02:30:00Z"), "12:00", "14:00", MEL)?.toISOString()).toBe("2026-11-04T03:00:00.000Z");
    expect(quietUntil(at("2026-11-04T12:30:00Z"), null, null, MEL)).toBeNull(); expect(quietUntil(at("2026-11-04T12:30:00Z"), "07:00", "07:00", MEL)).toBeNull();
  });
  it("the same instant is quiet in one place and awake in another", () => {
    const now = at("2026-06-15T13:30:00Z");               // Perth (UTC+8) 21:30, Melbourne (UTC+10 in winter) 23:30
    expect(quietUntil(now, "23:00", "07:00", PER)).toBeNull(); expect(quietUntil(now, "23:00", "07:00", MEL)).not.toBeNull();
  });
  it("is right across the daylight saving change", () => {
    // Melbourne clocks go forward at 02:00 on 2026-10-04: 07:00 that morning is AEDT (UTC+11) = 20:00Z on the 3rd
    expect(quietUntil(at("2026-10-03T14:30:00Z"), "22:00", "07:00", MEL)?.toISOString()).toBe("2026-10-03T20:00:00.000Z");
    // and back on 2027-04-04: 07:00 that morning is AEST (UTC+10) = 21:00Z on the 3rd
    expect(quietUntil(at("2027-04-03T14:30:00Z"), "22:00", "07:00", MEL)?.toISOString()).toBe("2027-04-03T21:00:00.000Z");
  });
});

describe("what to do with a matched event", () => {
  const night = new Date("2026-11-04T12:30:00Z");
  it("holds ordinary events in quiet hours and delivers critical ones at once", () => {
    const q = rule({ quietStart: "22:00", quietEnd: "07:00", channels: ["in_app", "email"] });
    expect(plan(q, ev(), night, MEL)).toEqual({ status: "held", heldUntil: new Date("2026-11-04T20:00:00Z"), emailStatus: "held" });
    expect(plan({ ...q, critical: true }, ev(), night, MEL)).toEqual({ status: "delivered", heldUntil: null, emailStatus: "sent" });
    expect(plan(q, ev({ severity: "critical" }), night, MEL).status).toBe("delivered");
    expect(plan(q, ev(), new Date("2026-11-04T03:00:00Z"), MEL)).toEqual({ status: "delivered", heldUntil: null, emailStatus: "sent" });
  });
  it("email follows the channel and the digest setting", () => {
    expect(plan(rule(), ev(), night, MEL).emailStatus).toBe("none"); expect(plan(rule({ channels: ["email"], digest: true }), ev(), night, MEL).emailStatus).toBe("digest");
  });
  it("the next summary is at the stated local time, today if it is still ahead, otherwise tomorrow", () => {
    expect(nextDigest(new Date("2026-11-04T05:00:00Z"), "18:00", MEL).toISOString()).toBe("2026-11-04T07:00:00.000Z");        // 16:00 local now, 18:00 AEDT = 07:00Z
    expect(nextDigest(new Date("2026-11-04T07:00:00Z"), "18:00", MEL).toISOString()).toBe("2026-11-05T07:00:00.000Z");
  });
});
