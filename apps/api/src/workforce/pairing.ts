import { businessDate } from "../common/business-day";

export interface PunchIn { id: string; kind: "in" | "out"; at: number }
export interface Pair { inId: string; outId: string | null; inAt: number; outAt: number | null; flags: string[] }
export const OPEN_TOO_LONG_MS = 16 * 3_600_000;

/**
 * Turn a person's punches (already without superseded ones) into worked stretches, in time order.
 * An `in` with no `out` before the next `in` is a forgotten clock-out; an `in` still open after 16 hours is too; one open for less is simply "still in".
 * An `out` with nothing open is returned as an orphan for a manager to look at.
 */
export function pairPunches(punches: PunchIn[], now: number): { pairs: Pair[]; orphans: string[] } {
  const sorted = [...punches].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "in" ? -1 : 1));
  const pairs: Pair[] = []; const orphans: string[] = []; let open: PunchIn | null = null;
  for (const p of sorted) {
    if (p.kind === "in") { if (open) pairs.push({ inId: open.id, outId: null, inAt: open.at, outAt: null, flags: ["missing_out"] }); open = p; }
    else if (open) { pairs.push({ inId: open.id, outId: p.id, inAt: open.at, outAt: p.at, flags: [] }); open = null; }
    else orphans.push(p.id);
  }
  if (open) pairs.push({ inId: open.id, outId: null, inAt: open.at, outAt: null, flags: now - open.at > OPEN_TOO_LONG_MS ? ["missing_out"] : ["still_in"] });
  return { pairs, orphans };
}

export interface ShiftSpan { id: string; startsAt: number; endsAt: number; breakMinutes: number }
/** The shift this stretch belongs to: the one starting nearest to the clock-in, from three hours before its start to its end. */
export function matchShift(inAt: number, shifts: ShiftSpan[]): ShiftSpan | null {
  let best: ShiftSpan | null = null;
  for (const s of shifts) { if (inAt < s.startsAt - 3 * 3_600_000 || inAt > s.endsAt) continue; if (!best || Math.abs(inAt - s.startsAt) < Math.abs(inAt - best.startsAt)) best = s; }
  return best;
}
const mins = (ms: number) => Math.round(ms / 60_000);

export interface Computed { localDate: string; shiftId: string | null; breakMinutes: number; workedMinutes: number | null; scheduledMinutes: number | null; lateMinutes: number; varianceMinutes: number | null; flags: string[] }
/** Worked time is real elapsed time (instants), so a night across a daylight-saving change counts the hours that actually passed. */
export function computeEntry(p: Pair, shifts: ShiftSpan[], loc: { timezone: string; dayCutoff: string }): Computed {
  const sh = matchShift(p.inAt, shifts); const flags = [...p.flags];
  const gross = p.outAt === null ? null : mins(p.outAt - p.inAt);
  const brk = sh && gross !== null && gross >= 300 ? sh.breakMinutes : 0;
  const worked = gross === null ? null : Math.max(0, gross - brk);
  const scheduled = sh ? mins(sh.endsAt - sh.startsAt) - sh.breakMinutes : null;
  const late = sh ? Math.max(0, mins(p.inAt - sh.startsAt)) : 0;
  if (!sh) flags.push("no_shift"); if (late > 0) flags.push("late");
  if (sh && p.outAt !== null && sh.endsAt - p.outAt > 15 * 60_000) flags.push("left_early");
  return { localDate: businessDate(new Date(p.inAt), loc.timezone, loc.dayCutoff), shiftId: sh?.id ?? null, breakMinutes: brk, workedMinutes: worked, scheduledMinutes: scheduled, lateMinutes: late, varianceMinutes: worked !== null && scheduled !== null ? worked - scheduled : null, flags };
}
