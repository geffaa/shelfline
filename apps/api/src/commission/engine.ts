import { allocate, divRound, percentBp } from "@shelfline/money";

export type Basis = "net_ex_tax" | "margin";
export type SplitMode = "seller" | "equal" | "weighted" | "hours_pool";
export type ScopeKind = "default" | "location" | "category" | "brand" | "variant";
export const PRIORITY: Record<ScopeKind, number> = { variant: 5, brand: 4, category: 3, location: 2, default: 1 };

export interface RuleVersion { id: string; version: number; validFrom: string; enabled: boolean; basis: Basis; rateBp: number; splitMode: SplitMode; weights: Record<string, number> }
export interface RuleSet { id: string; scopeKind: ScopeKind; scopeValue: string | null; versions: RuleVersion[] }
export interface LineScope { locationId: string; categoryId: string | null; brand: string | null; variantId: string }

const matches = (s: RuleSet, c: LineScope) => s.scopeKind === "default" || (s.scopeKind === "location" && s.scopeValue === c.locationId) || (s.scopeKind === "category" && s.scopeValue === c.categoryId)
  || (s.scopeKind === "brand" && !!c.brand && s.scopeValue === c.brand.trim().toLowerCase()) || (s.scopeKind === "variant" && s.scopeValue === c.variantId);

/** The version of a set in force on a business date: the latest one whose date has come. */
export function versionOn(s: RuleSet, date: string): RuleVersion | null {
  let best: RuleVersion | null = null;
  for (const v of s.versions) if (v.validFrom <= date && (!best || v.validFrom > best.validFrom)) best = v;
  return best;
}

/**
 * The rule for a line: variant > brand > category > location > default, using the version in force on the sale's own date.
 * A set that has no version yet on that date is skipped; one whose version in force is switched off ends the search with "no commission",
 * which is how a brand or a variant is excluded from the general rate.
 */
export function pickRule(sets: RuleSet[], scope: LineScope, date: string): RuleVersion | null {
  const ranked = sets.filter((s) => matches(s, scope)).sort((a, b) => PRIORITY[b.scopeKind] - PRIORITY[a.scopeKind]);
  for (const s of ranked) { const v = versionOn(s, date); if (!v) continue; return v.enabled ? v : null; }
  return null;
}

export interface LineFacts { qty: number; totalMinor: number; taxMinor: number; unitCostMinor: number | null }
/** What the rate is applied to. Net is the line total less the tax inside it; margin is net less cost (never below zero; a missing cost counts as no margin rather than as a guess). */
export function baseOf(basis: Basis, l: LineFacts): number {
  const net = l.totalMinor - l.taxMinor;
  if (basis === "net_ex_tax") return Math.max(0, net);
  return l.unitCostMinor === null ? 0 : Math.max(0, net - l.unitCostMinor * l.qty);
}
export const commissionOf = (base: number, rateBp: number) => percentBp(base, rateBp);

export interface Person { userId: string; role?: string | null }
export interface SplitCtx { sellerId: string; onShift: Person[]; minutes: Map<string, number> }
export const DEFAULT_WEIGHT = 100;
/** Who shares one line's commission, and in what proportion. Anything that cannot be resolved falls back to the seller, so nothing is lost. */
export function recipients(mode: SplitMode, weights: Record<string, number>, ctx: SplitCtx): { userId: string; weight: number }[] {
  const seller = [{ userId: ctx.sellerId, weight: 1 }];
  const by = new Map<string, number>();
  const add = (u: string, w: number) => by.set(u, Math.max(by.get(u) ?? 0, w));
  if (mode === "seller") return seller;
  if (mode === "equal") for (const p of ctx.onShift) add(p.userId, 1);
  else if (mode === "weighted") for (const p of ctx.onShift) add(p.userId, Math.max(0, Math.round(p.role && weights[p.role] !== undefined ? weights[p.role]! : DEFAULT_WEIGHT)));
  else for (const [u, m] of ctx.minutes) if (m > 0) add(u, m);
  const list = [...by].filter(([, w]) => w > 0).map(([userId, weight]) => ({ userId, weight })).sort((a, b) => (a.userId < b.userId ? -1 : 1));
  return list.length ? list : seller;
}

/** Shares of one amount that always add back up to it; the odd cent goes to the largest weight. */
export function split(amount: number, parts: { userId: string; weight: number }[]): { userId: string; amountMinor: number }[] {
  const out = allocate(amount, parts.map((p) => p.weight));
  return parts.map((p, i) => ({ userId: p.userId, amountMinor: out[i]! })).filter((x) => x.amountMinor !== 0);
}

/**
 * Clawback for refunds of one sale line, in the order they happened. Each person gives back the same share of what they earned
 * as the share of the line that has now been returned, counted cumulatively so the pieces add up exactly: refunding everything gives back everything.
 */
export function clawbacks(earned: { userId: string; amountMinor: number }[], lineQty: number, refunds: { key: string; qty: number }[]): Map<string, { userId: string; amountMinor: number }[]> {
  const out = new Map<string, { userId: string; amountMinor: number }[]>(); const given = new Map<string, number>(); let cum = 0;
  for (const r of refunds) {
    cum = Math.min(lineQty, cum + r.qty); const rows: { userId: string; amountMinor: number }[] = [];
    for (const e of earned) {
      const total = Number(divRound(BigInt(e.amountMinor) * BigInt(cum), BigInt(lineQty))); const delta = total - (given.get(e.userId) ?? 0);
      given.set(e.userId, total); if (delta !== 0) rows.push({ userId: e.userId, amountMinor: -delta });
    }
    out.set(r.key, rows);
  }
  return out;
}
