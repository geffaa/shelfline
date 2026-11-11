import { allocate, divRound } from "@shelfline/money";

export interface ReceiptLineIn { qty: number; unitCostMinor: number }
export interface LandedLine { allocMinor: number; landedUnitCostMinor: number }

/**
 * Freight and other costs are spread over the receipt's lines in proportion to line value (largest remainder, so the shares add up exactly).
 * The ledger takes a whole-cent cost per unit, so the landed unit cost is the line's (value + share) / qty, rounded half away from zero;
 * the exact share stays on the receipt line for the books.
 */
export function landedCosts(lines: ReceiptLineIn[], extraMinor: number): LandedLine[] {
  const value = lines.map((l) => l.qty * l.unitCostMinor);
  const weights = value.some((v) => v > 0) ? value : lines.map((l) => l.qty);
  const shares = extraMinor > 0 ? allocate(extraMinor, weights) : lines.map(() => 0);
  return lines.map((l, i) => ({ allocMinor: shares[i]!, landedUnitCostMinor: Number(divRound(BigInt(value[i]! + shares[i]!), BigInt(l.qty))) }));
}

export type MatchStatus = "ok" | "over_billed" | "price_variance" | "both";
export interface MatchInput { billedQty: number; billedQtyBefore: number; receivedQty: number; billedUnitMinor: number; orderedUnitMinor: number }
export interface MatchResult { billedQtyToDate: number; qtyDiff: number; costDiffMinor: number; status: MatchStatus }

/** Three-way match for one bill line: billed (to date, across bills) against received, and billed price against the order price. */
export function matchLine(m: MatchInput): MatchResult {
  const billedQtyToDate = m.billedQtyBefore + m.billedQty;
  const qtyDiff = billedQtyToDate - m.receivedQty;                       // > 0: billed for goods that have not arrived
  const costDiffMinor = (m.billedUnitMinor - m.orderedUnitMinor) * m.billedQty;
  const over = qtyDiff > 0, price = m.billedUnitMinor !== m.orderedUnitMinor;
  return { billedQtyToDate, qtyDiff, costDiffMinor, status: over && price ? "both" : over ? "over_billed" : price ? "price_variance" : "ok" };
}
export const holdReasons = (rows: { status: MatchStatus }[]): string[] => [
  ...(rows.some((r) => r.status === "over_billed" || r.status === "both") ? ["over_billed"] : []),
  ...(rows.some((r) => r.status === "price_variance" || r.status === "both") ? ["price_variance"] : []),
];

export interface AgingBill { dueOn: string; outstandingMinor: number; held: boolean }
export const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type Bucket = (typeof BUCKETS)[number];
/** Days past due (calendar days, UTC date strings) -> bucket. Not yet due, or due today, is "current". */
export function bucketOf(dueOn: string, asOf: string): Bucket {
  const days = Math.floor((Date.parse(asOf + "T00:00:00Z") - Date.parse(dueOn + "T00:00:00Z")) / 86_400_000);
  return days <= 0 ? "current" : days <= 30 ? "d1_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90plus";
}
