import { localParts, zonedInstant } from "../common/business-day";

export type Severity = "info" | "warning" | "critical";
/** What happened, in the terms a rule can talk about. Built from a source row by the service; everything below is pure. */
export interface NotifyEvent { kind: string; ref: string; locationId: string | null; severity: Severity; title: string; body: string; facts: { amountMinor?: number; varianceMinor?: number; lateMinutes?: number } }
export interface RuleFacts {
  id: string; eventKind: string; locationIds: string[] | null; conditions: { minMinor?: number; minLateMinutes?: number; varianceOverMinor?: number };
  channels: string[]; quietStart: string | null; quietEnd: string | null; critical: boolean; digest: boolean; digestAt: string; active: boolean;
}

/** Does this rule care about this event? Same kind, a place it covers, and the condition (if any) holds. Thresholds are inclusive. */
export function ruleMatches(r: RuleFacts, e: NotifyEvent): boolean {
  if (!r.active || r.eventKind !== e.kind) return false;
  if (r.locationIds && (!e.locationId || !r.locationIds.includes(e.locationId))) return false;
  const c = r.conditions;
  if (c.minMinor !== undefined && (e.facts.amountMinor ?? 0) < c.minMinor) return false;
  if (c.minLateMinutes !== undefined && (e.facts.lateMinutes ?? 0) < c.minLateMinutes) return false;
  if (c.varianceOverMinor !== undefined && Math.abs(e.facts.varianceMinor ?? 0) <= c.varianceOverMinor) return false;
  return true;
}

const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/**
 * If `now` falls inside the quiet window (which may run past midnight, such as 22:00 to 07:00) in the place's own time, the moment the window ends; otherwise null.
 * The start is inclusive and the end exclusive, so 07:00 itself is already awake.
 */
export function quietUntil(now: Date, start: string | null, end: string | null, timeZone: string): Date | null {
  if (!start || !end || start === end) return null;
  const { date, minutes } = localParts(now, timeZone); const s = mins(start), e = mins(end);
  const inside = s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
  if (!inside) return null;
  const endDate = s < e || minutes < e ? date : new Date(Date.parse(date + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  return new Date(zonedInstant(endDate, end, timeZone));
}

/** What to do with one matched event for one person right now. Critical events and critical rules ignore quiet hours. */
export interface Delivery { status: "delivered" | "held"; heldUntil: Date | null; emailStatus: "none" | "sent" | "held" | "digest" }
export function plan(r: RuleFacts, e: NotifyEvent, now: Date, timeZone: string): Delivery {
  const wantsEmail = r.channels.includes("email"); const bypass = r.critical || e.severity === "critical";
  const until = bypass ? null : quietUntil(now, r.quietStart, r.quietEnd, timeZone);
  if (until) return { status: "held", heldUntil: until, emailStatus: wantsEmail ? "held" : "none" };
  return { status: "delivered", heldUntil: null, emailStatus: !wantsEmail ? "none" : r.digest ? "digest" : "sent" };
}

/** The next time a daily summary is due at `digestAt` local time, strictly after `after`. */
export function nextDigest(after: Date, digestAt: string, timeZone: string): Date {
  const { date } = localParts(after, timeZone); const today = new Date(zonedInstant(date, digestAt, timeZone));
  return today.getTime() > after.getTime() ? today : new Date(zonedInstant(new Date(Date.parse(date + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10), digestAt, timeZone));
}

export const money = (m: number) => `A$${(Math.abs(m) / 100).toFixed(2)}`;
