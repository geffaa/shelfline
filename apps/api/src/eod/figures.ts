import { createHash } from "node:crypto";
import { businessDate, localParts, zonedInstant } from "../common/business-day";

export interface LocationFigures { id: string; name: string; orders: number; grossMinor: number; discountMinor: number; refundsMinor: number; netMinor: number; taxMinor: number; tenders: Record<string, number>; noSales: number; sessionsClosed: number; sessionsOpen: number; varianceMinor: number }
export interface Figures { localDate: string; locations: LocationFigures[]; totals: Omit<LocationFigures, "id" | "name"> }
export type RunStatus = "provisional" | "final" | "amended";

/** Two reports are "the same" when their figures are. Nothing else (time generated, version) takes part. */
export const checksumOf = (f: Figures) => createHash("sha256").update(JSON.stringify(f)).digest("hex");

export function totalsOf(ls: LocationFigures[]): Figures["totals"] {
  const t: Figures["totals"] = { orders: 0, grossMinor: 0, discountMinor: 0, refundsMinor: 0, netMinor: 0, taxMinor: 0, tenders: {}, noSales: 0, sessionsClosed: 0, sessionsOpen: 0, varianceMinor: 0 };
  for (const l of ls) { t.orders += l.orders; t.grossMinor += l.grossMinor; t.discountMinor += l.discountMinor; t.refundsMinor += l.refundsMinor; t.netMinor += l.netMinor; t.taxMinor += l.taxMinor; t.noSales += l.noSales; t.sessionsClosed += l.sessionsClosed; t.sessionsOpen += l.sessionsOpen; t.varianceMinor += l.varianceMinor; for (const [k, v] of Object.entries(l.tenders)) t.tenders[k] = (t.tenders[k] ?? 0) + v; }
  return t;
}

/** The moments a schedule fires around `now`: a send time on each allowed weekday of the schedule's own clock, with the business day it reports on. DST-correct because the instant is built from the wall-clock time in the zone. */
export function dueDays(o: { sendAtLocal: string; daysOfWeek: number[]; timezone: string; cutoff: string }, now: Date): { runAt: Date; reportDate: string }[] {
  const today = localParts(now, o.timezone).date; const out: { runAt: Date; reportDate: string }[] = [];
  for (const d of [-1, 0]) {
    const day = new Date(Date.parse(today + "T12:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
    if (!o.daysOfWeek.includes(new Date(day + "T12:00:00Z").getUTCDay())) continue;
    const runAt = new Date(zonedInstant(day, o.sendAtLocal, o.timezone)); if (runAt.getTime() > now.getTime()) continue;
    out.push({ runAt, reportDate: businessDate(runAt, o.timezone, o.cutoff) });
  }
  return out;
}

const m = (n: number) => `${n < 0 ? "-" : ""}${(Math.abs(n) / 100).toFixed(2)}`;
const nice = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const subjectOf = (status: RunStatus, name: string, date: string) => `${status === "provisional" ? "[Provisional] " : status === "amended" ? "[Amended] " : ""}End of day: ${name}, ${nice(date)}`;

export function renderLines(name: string, status: RunStatus, f: Figures, notes: string[], version: number): string[] {
  const L: string[] = [`${name}  |  ${nice(f.localDate)}  |  version ${version}`, ""];
  if (status === "provisional") L.push("PROVISIONAL: not everything had reached the server when this was written.");
  if (status === "amended") L.push("AMENDED: figures changed after the earlier version. This replaces it.");
  for (const n of notes) L.push(`  - ${n}`); if (notes.length || status !== "final") L.push("");
  const row = (k: string, v: string | number) => L.push(`${k.padEnd(28, ".")} ${String(v).padStart(14)}`);
  for (const l of [...f.locations, { ...f.totals, id: "", name: "ALL LOCATIONS" }]) {
    L.push(l.name.toUpperCase()); row("Orders", l.orders); row("Gross sales", m(l.grossMinor)); row("Discounts", m(-l.discountMinor)); row("Refunds", m(-l.refundsMinor)); row("Net sales", m(l.netMinor)); row("GST included", m(l.taxMinor));
    for (const [k, v] of Object.entries(l.tenders).sort()) row(`  Taken as ${k.replace("_", " ")}`, m(v));
    row("No-sale drawer opens", l.noSales); row("Registers closed / open", `${l.sessionsClosed} / ${l.sessionsOpen}`); row("Cash variance", m(l.varianceMinor)); L.push("");
  }
  return L;
}
export function renderCsv(f: Figures): string {
  const head = "location,orders,gross,discounts,refunds,net,gst_included,no_sales,registers_closed,registers_open,cash_variance";
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const row = (n: string, l: Omit<LocationFigures, "id" | "name">) => [cell(n), l.orders, m(l.grossMinor), m(-l.discountMinor), m(-l.refundsMinor), m(l.netMinor), m(l.taxMinor), l.noSales, l.sessionsClosed, l.sessionsOpen, m(l.varianceMinor)].join(",");
  return [head, ...f.locations.map((l) => row(l.name, l)), row("All locations", f.totals)].join("\n") + "\n";
}
