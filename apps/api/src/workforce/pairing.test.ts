import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { zonedInstant } from "../common/business-day";
import { computeEntry, matchShift, pairPunches, type PunchIn } from "./pairing";

const MEL = { timezone: "Australia/Melbourne", dayCutoff: "04:00" };
const at = (date: string, hm: string, tz = MEL.timezone) => zonedInstant(date, hm, tz);
const p = (id: string, kind: "in" | "out", t: number): PunchIn => ({ id, kind, at: t });

describe("zonedInstant (daylight saving)", () => {
  it("reads wall-clock times in the zone, including the days the clocks change", () => {
    expect(new Date(at("2026-11-04", "09:00")).toISOString()).toBe("2026-11-03T22:00:00.000Z");              // AEDT, +11
    expect(new Date(at("2026-06-15", "09:00")).toISOString()).toBe("2026-06-14T23:00:00.000Z");              // AEST, +10
    expect(at("2026-10-04", "06:00") - at("2026-10-03", "22:00")).toBe(7 * 3_600_000);                       // clocks go forward at 02:00 on 4 Oct: the night is an hour short
    expect(at("2026-04-05", "06:00") - at("2026-04-04", "22:00")).toBe(9 * 3_600_000);                       // clocks go back at 03:00 on 5 Apr: the night is an hour long
    expect(new Date(at("2026-10-04", "02:30")).toISOString()).toBe("2026-10-03T16:30:00.000Z");              // a time that does not exist lands after the gap (03:30 AEDT)
    expect(new Date(at("2026-04-05", "02:30")).toISOString()).toBe("2026-04-04T16:30:00.000Z");              // a repeated time resolves to its second occurrence (standard time)
    expect(new Date(at("2026-11-04", "09:00", "Australia/Perth")).toISOString()).toBe("2026-11-04T01:00:00.000Z");
  });
  it("property: the wall clock read back from the instant equals what was asked for, except in the skipped hour", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 364 }), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), (d, h, m) => {
      const date = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10); const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; const t = at(date, hm);
      const back = new Intl.DateTimeFormat("en-CA", { timeZone: MEL.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)); const g = Object.fromEntries(back.map((x) => [x.type, x.value]));
      const skipped = date === "2026-10-04" && h === 2; if (!skipped) expect(`${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}`).toBe(`${date} ${hm}`);
    }));
  });
});

describe("pairing punches", () => {
  const t0 = at("2026-11-04", "09:00"); const H = 3_600_000;
  it("pairs in and out in order; a forgotten clock-out is flagged when the next in arrives, or once 16 hours have passed, and is merely 'still in' before that", () => {
    expect(pairPunches([p("i1", "in", t0), p("o1", "out", t0 + 8 * H)], t0 + 9 * H).pairs).toEqual([{ inId: "i1", outId: "o1", inAt: t0, outAt: t0 + 8 * H, flags: [] }]);
    const r = pairPunches([p("i1", "in", t0), p("i2", "in", t0 + 24 * H), p("o2", "out", t0 + 32 * H)], t0 + 40 * H); expect(r.pairs.map((x) => [x.inId, x.outId, x.flags])).toEqual([["i1", null, ["missing_out"]], ["i2", "o2", []]]);
    expect(pairPunches([p("i", "in", t0)], t0 + 3 * H).pairs[0]!.flags).toEqual(["still_in"]); expect(pairPunches([p("i", "in", t0)], t0 + 17 * H).pairs[0]!.flags).toEqual(["missing_out"]);
    expect(pairPunches([p("o", "out", t0), p("i", "in", t0 + H), p("o2", "out", t0 + 2 * H)], t0 + 3 * H)).toMatchObject({ orphans: ["o"], pairs: [{ inId: "i", outId: "o2" }] });
  });
  it("property: every punch lands in exactly one pair or is an orphan, and pairs never overlap", () => {
    fc.assert(fc.property(fc.array(fc.record({ k: fc.constantFrom("in", "out") as fc.Arbitrary<"in" | "out">, dt: fc.integer({ min: 1, max: 20 }) }), { maxLength: 30 }), (ev) => {
      let t = t0; const ps = ev.map((e, i) => { t += e.dt * 600_000; return p(`p${i}`, e.k, t); }); const r = pairPunches(ps, t + 99 * H);
      const used = [...r.pairs.flatMap((x) => [x.inId, ...(x.outId ? [x.outId] : [])]), ...r.orphans].sort(); expect(used).toEqual(ps.map((x) => x.id).sort());
      const sp = [...r.pairs].sort((a, b) => a.inAt - b.inAt); sp.forEach((x, i) => { if (i && sp[i - 1]!.outAt !== null) expect(sp[i - 1]!.outAt!).toBeLessThanOrEqual(x.inAt); });
    }));
  });
});

describe("an entry against its shift", () => {
  const sh = { id: "s1", startsAt: at("2026-11-04", "09:00"), endsAt: at("2026-11-04", "17:00"), breakMinutes: 30 };
  it("clock-in at 09:12 for a 09:00 shift is 12 minutes late; worked time is real time less the break; variance is against the paid schedule", () => {
    const e = computeEntry({ inId: "i", outId: "o", inAt: at("2026-11-04", "09:12"), outAt: at("2026-11-04", "17:00"), flags: [] }, [sh], MEL);
    expect(e).toMatchObject({ localDate: "2026-11-04", shiftId: "s1", lateMinutes: 12, breakMinutes: 30, workedMinutes: 8 * 60 - 12 - 30, scheduledMinutes: 450, varianceMinutes: -12 }); expect(e.flags).toEqual(["late"]);
    expect(computeEntry({ inId: "i", outId: "o", inAt: at("2026-11-04", "08:55"), outAt: at("2026-11-04", "16:30"), flags: [] }, [sh], MEL)).toMatchObject({ lateMinutes: 0, flags: ["left_early"] });
  });
  it("no shift in range is 'no_shift'; a stretch with no clock-out has no worked time; the nearest shift wins", () => {
    expect(computeEntry({ inId: "i", outId: null, inAt: at("2026-11-05", "09:00"), outAt: null, flags: ["missing_out"] }, [sh], MEL)).toMatchObject({ shiftId: null, workedMinutes: null, varianceMinutes: null, flags: ["missing_out", "no_shift"] });
    const later = { ...sh, id: "s2", startsAt: at("2026-11-04", "13:00"), endsAt: at("2026-11-04", "21:00") }; expect(matchShift(at("2026-11-04", "12:40"), [sh, later])!.id).toBe("s2"); expect(matchShift(at("2026-11-04", "05:00"), [sh])).toBeNull();
  });
  it("a night shift across the clocks going forward is seven real hours and belongs to the day it started; across them going back it is nine", () => {
    const night = { id: "n", startsAt: at("2026-10-03", "22:00"), endsAt: at("2026-10-04", "06:00"), breakMinutes: 0 };
    const e = computeEntry({ inId: "i", outId: "o", inAt: at("2026-10-03", "22:00"), outAt: at("2026-10-04", "06:00"), flags: [] }, [night], MEL); expect(e).toMatchObject({ localDate: "2026-10-03", workedMinutes: 420, scheduledMinutes: 420, varianceMinutes: 0 });
    const back = { id: "b", startsAt: at("2026-04-04", "22:00"), endsAt: at("2026-04-05", "06:00"), breakMinutes: 0 };
    expect(computeEntry({ inId: "i", outId: "o", inAt: at("2026-04-04", "22:00"), outAt: at("2026-04-05", "06:00"), flags: [] }, [back], MEL)).toMatchObject({ localDate: "2026-04-04", workedMinutes: 540, scheduledMinutes: 540 });
    expect(computeEntry({ inId: "i", outId: "o", inAt: at("2026-10-04", "03:30"), outAt: at("2026-10-04", "05:00"), flags: [] }, [], MEL).localDate).toBe("2026-10-03");     // 03:30 AEDT is before the 04:00 cutoff: still the previous business day
  });
});
