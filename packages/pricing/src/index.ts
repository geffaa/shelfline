import { allocate, cashRound, divRound, taxFromInclusive, taxOnExclusive, assertMinor, type Minor } from "@shelfline/money";

/** Runs unchanged on the POS (offline) and on the server; the same golden vectors gate both. */
export interface TaxRule { rateBp: number; inclusive: boolean }
export interface LineInput { unitPriceMinor: Minor; qty: number; discountMinor: Minor; tax: TaxRule }
export interface LineResult {
  listMinor: Minor;      // unit * qty, before discount
  discountMinor: Minor;
  totalMinor: Minor;     // what the customer pays for the line, tax included
  taxMinor: Minor;       // tax contained in totalMinor (allocated from the tax-group total)
  exTaxMinor: Minor;     // totalMinor - taxMinor
}
export interface CartResult {
  lines: LineResult[]; subtotalMinor: Minor; discountMinor: Minor; taxMinor: Minor; totalMinor: Minor;
  cashRoundingMinor: Minor; // applied only when cash is the only tender; 0 otherwise
  payableMinor: Minor;
}
export interface CartOptions { cashRoundingStep?: number | null }

/**
 * Method (decided 2026-11-04): tax is computed per tax group (same rate + inclusive flag) on the group's total, not per line,
 * then spread over the group's lines with largest-remainder so line taxes sum exactly to the group tax.
 * Inclusive: tax = round(total * r / (1 + r)). Exclusive: tax = round(exTax * r), total = exTax + tax.
 */
export function priceCart(inputs: LineInput[], opts: CartOptions = {}): CartResult {
  inputs.forEach((l, i) => {
    assertMinor(l.unitPriceMinor, `line ${i} unit price`); assertMinor(l.discountMinor, `line ${i} discount`);
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new RangeError(`line ${i}: qty must be a positive integer`);
    if (l.unitPriceMinor < 0 || l.discountMinor < 0) throw new RangeError(`line ${i}: negative amount`);
    if (l.discountMinor > l.unitPriceMinor * l.qty) throw new RangeError(`line ${i}: discount exceeds line value`);
    if (!Number.isInteger(l.tax.rateBp) || l.tax.rateBp < 0 || l.tax.rateBp > 10000) throw new RangeError(`line ${i}: bad tax rate`);
  });
  const net = inputs.map((l) => l.unitPriceMinor * l.qty - l.discountMinor); // price after discount, in the price's own basis
  const groups = new Map<string, number[]>();
  inputs.forEach((l, i) => { const k = `${l.tax.rateBp}|${l.tax.inclusive ? 1 : 0}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); });

  const tax: Minor[] = new Array(inputs.length).fill(0);
  const total: Minor[] = new Array(inputs.length).fill(0);
  for (const [k, idx] of groups) {
    const [bp, incl] = k.split("|").map(Number) as [number, number];
    const base = idx.reduce((a, i) => a + net[i]!, 0);
    const groupTax = incl ? taxFromInclusive(base, bp) : taxOnExclusive(base, bp);
    const parts = base === 0 || groupTax === 0 ? idx.map(() => 0) : allocate(groupTax, idx.map((i) => net[i]!));
    idx.forEach((i, j) => { tax[i] = parts[j]!; total[i] = incl ? net[i]! : net[i]! + parts[j]!; });
  }
  const lines = inputs.map((l, i): LineResult => ({
    listMinor: l.unitPriceMinor * l.qty, discountMinor: l.discountMinor, totalMinor: total[i]!, taxMinor: tax[i]!, exTaxMinor: total[i]! - tax[i]!,
  }));
  const sum = (f: (l: LineResult) => number) => lines.reduce((a, l) => a + f(l), 0);
  const totalMinor = sum((l) => l.totalMinor);
  const step = opts.cashRoundingStep ?? null;
  const cashRoundingMinor = step ? cashRound(totalMinor, step) - totalMinor : 0;
  return { lines, subtotalMinor: sum((l) => l.listMinor), discountMinor: sum((l) => l.discountMinor), taxMinor: sum((l) => l.taxMinor), totalMinor, cashRoundingMinor, payableMinor: totalMinor + cashRoundingMinor };
}

export interface RateRow { region: string | null; rateBp: number; taxInclusive: boolean; validFrom: string; validTo: string | null }
/** Picks the rate in force on `onDate` (YYYY-MM-DD): a region-specific rate wins over the default (region = null); ranges are [from, to). */
export function resolveTaxRule(rates: RateRow[], region: string | null, onDate: string): TaxRule | null {
  const live = rates.filter((r) => r.validFrom <= onDate && (r.validTo === null || onDate < r.validTo));
  const pick = (live.find((r) => region !== null && r.region === region) ?? live.find((r) => r.region === null)) ?? null;
  return pick ? { rateBp: pick.rateBp, inclusive: pick.taxInclusive } : null;
}

export interface RefundableLine { qty: number; refundedQty: number; totalMinor: Minor; refundedMinor: Minor; taxMinor: Minor; refundedTaxMinor: Minor }
/**
 * What a refund of `qty` units of a sale line returns. The last units of a line take whatever is left of the line's total and tax,
 * so refunding a line in any number of steps returns exactly what was paid, never a cent more or less.
 * Over-refunding (more units than remain) is priced pro rata and capped to what remains.
 */
export function refundAmount(l: RefundableLine, qty: number): { amountMinor: Minor; taxMinor: Minor } {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
  const remainQty = l.qty - l.refundedQty, remainAmt = l.totalMinor - l.refundedMinor, remainTax = l.taxMinor - l.refundedTaxMinor;
  if (remainQty <= 0 || remainAmt <= 0) return { amountMinor: 0, taxMinor: 0 };
  if (qty >= remainQty) return { amountMinor: remainAmt, taxMinor: remainTax };
  const amountMinor = Math.min(remainAmt, Number(divRound(BigInt(l.totalMinor) * BigInt(qty), BigInt(l.qty))));
  const taxMinor = Math.min(remainTax, amountMinor, Number(divRound(BigInt(l.taxMinor) * BigInt(qty), BigInt(l.qty))));
  return { amountMinor, taxMinor };
}

export * from "./rules";
