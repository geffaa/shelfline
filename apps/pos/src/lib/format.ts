const f = new Intl.NumberFormat("en-US", { style: "currency", currency: "AUD" });   // en-US gives "A$" for AUD, unambiguous next to other dollars
export const fmt = (minor: number) => f.format(minor / 100);
/** "12.5" -> 1250; null when it is not a price with at most 2 decimals. */
export function parseMoney(s: string): number | null { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null; }
export const clockTime = (d: Date) => d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
