export interface Rules { lastPurchaseBeforeDays?: number; lastPurchaseWithinDays?: number; minOrders?: number; maxOrders?: number; minSpentMinor?: number; locationIds?: string[]; tiers?: string[]; birthdayMonth?: number; neverPurchased?: boolean }
export interface Facts { orders: number; spentMinor: number; lastPurchaseAt: Date | null; locationIds: string[]; tier: string; birthMonth: number | null }
const DAY = 86_400_000;

/** Does a customer belong to a segment? Every stated condition must hold; an empty rule set is everyone. "Days" are whole days back from `now`. */
export function matchSegment(r: Rules, f: Facts, now: Date): boolean {
  const ago = f.lastPurchaseAt ? Math.floor((now.getTime() - f.lastPurchaseAt.getTime()) / DAY) : null;
  if (r.neverPurchased && f.orders > 0) return false;
  if (r.lastPurchaseBeforeDays !== undefined && (ago === null || ago < r.lastPurchaseBeforeDays)) return false;            // "lapsed": the last purchase was at least this long ago (never bought is not lapsed)
  if (r.lastPurchaseWithinDays !== undefined && (ago === null || ago > r.lastPurchaseWithinDays)) return false;
  if (r.minOrders !== undefined && f.orders < r.minOrders) return false; if (r.maxOrders !== undefined && f.orders > r.maxOrders) return false;
  if (r.minSpentMinor !== undefined && f.spentMinor < r.minSpentMinor) return false;
  if (r.locationIds?.length && !r.locationIds.some((l) => f.locationIds.includes(l))) return false;
  if (r.tiers?.length && !r.tiers.includes(f.tier)) return false;
  if (r.birthdayMonth !== undefined && f.birthMonth !== r.birthdayMonth) return false;
  return true;
}

export type Block = "no_email" | "no_consent" | "frequency";
/** May this person be sent a marketing email now? Consent is checked first and is never overridden by anything else: without an explicit yes, nothing goes. */
export function sendBlock(o: { email: string | null; consentEmail: boolean | undefined; lastMarketingAt: Date | null; minGapDays: number; now: Date }): Block | null {
  if (!o.email || !o.email.includes("@")) return "no_email";
  if (o.consentEmail !== true) return "no_consent";
  if (o.minGapDays > 0 && o.lastMarketingAt && o.now.getTime() - o.lastMarketingAt.getTime() < o.minGapDays * DAY) return "frequency";
  return null;
}

/** Fills {{name}}, {{points}} and {{tier}}. Unknown placeholders are left as they are rather than printed as "undefined". */
export function render(t: string, v: { name: string; points?: number; tier?: string }): string {
  return t.replace(/\{\{\s*(name|points|tier|first_name)\s*\}\}/g, (_m, k: string) => (k === "name" ? v.name : k === "first_name" ? v.name.split(/\s+/)[0]! : k === "points" ? String(v.points ?? 0) : (v.tier ?? "")));
}

export interface Tier { name: string; min: number; multBp: number }
/** The highest tier whose threshold the customer's lifetime points have reached. Tiers are sorted here, so the order they were saved in does not matter. */
export function tierFor(lifetime: number, tiers: Tier[]): Tier {
  const sorted = [...tiers].sort((a, b) => a.min - b.min); let best = sorted[0]!;
  for (const t of sorted) if (lifetime >= t.min) best = t; return best;
}
/** Points for a purchase: whole points per dollar of the sale without GST, times the tier's multiplier, rounded down. Never negative. */
export function pointsFor(netMinor: number, pointsPerDollar: number, multBp: number): number {
  if (netMinor <= 0 || pointsPerDollar <= 0) return 0;
  return Number((BigInt(netMinor) * BigInt(pointsPerDollar) * BigInt(multBp)) / (100n * 10000n));          // BigInt division already rounds down
}
/** How many points a refund takes back: the same share of what the sale earned as the share of the sale that was returned. A full refund takes back exactly what is left. */
export function clawbackFor(o: { earned: number; alreadyBack: number; refundNetMinor: number; saleNetMinor: number; fullyRefunded: boolean }): number {
  const remaining = Math.max(0, o.earned - o.alreadyBack); if (o.fullyRefunded || o.saleNetMinor <= 0) return remaining;
  return Math.min(remaining, Math.round((o.earned * o.refundNetMinor) / o.saleNetMinor));
}
