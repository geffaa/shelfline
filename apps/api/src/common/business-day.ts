/**
 * Business date of an instant at a location: local calendar date, but times before `cutoff` (HH:MM, local)
 * belong to the previous day. Uses the IANA zone, so DST is handled by the platform.
 */
export function localParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export function businessDate(at: Date, timeZone: string, cutoff = "04:00"): string {
  const m = /^(\d{2}):(\d{2})/.exec(cutoff);
  if (!m) throw new RangeError(`bad cutoff ${cutoff}`);
  const { date, minutes } = localParts(at, timeZone);
  if (minutes >= Number(m[1]) * 60 + Number(m[2])) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * The instant (ms since epoch) at which the wall clock in `timeZone` reads `date` + `hm`. Two passes of the zone's own offset handle daylight saving:
 * a time that does not exist (the hour skipped when clocks go forward) lands just after the gap; a repeated time resolves to its second occurrence (standard time).
 */
export function zonedInstant(date: string, hm: string, timeZone: string): number {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const offset = (t: number) => { const p = localPartsFull(new Date(t), timeZone); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t; };
  return guess - offset(guess - offset(guess));
}
function localPartsFull(at: Date, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}
