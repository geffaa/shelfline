/** Integer money in minor units (cents). Never floats. Rounding: half away from zero unless stated. */
export type Minor = number;

export function assertMinor(n: number, what = "amount"): asserts n is Minor {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer in minor units, got ${n}`);
}

/** Divide a/b (b > 0) rounding half away from zero, exact via BigInt. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("divisor must be positive");
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const q = (2n * abs + b) / (2n * b);
  return neg ? -q : q;
}

/** amount * bp / 10000, rounded half away from zero. bp = basis points (400 = 4%). */
export function percentBp(amount: Minor, bp: number): Minor {
  assertMinor(amount);
  if (!Number.isInteger(bp)) throw new RangeError("bp must be an integer");
  return Number(divRound(BigInt(amount) * BigInt(bp), 10000n));
}

/** Tax contained in a tax-inclusive gross amount at rateBp (1000 = 10%). */
export function taxFromInclusive(gross: Minor, rateBp: number): Minor {
  assertMinor(gross);
  return Number(divRound(BigInt(gross) * BigInt(rateBp), BigInt(10000 + rateBp)));
}

/** Tax to add on a tax-exclusive net amount. */
export function taxOnExclusive(net: Minor, rateBp: number): Minor {
  return percentBp(net, rateBp);
}

/**
 * Split `total` across `weights` so the parts sum exactly to total (largest-remainder method).
 * Ties on the remainder go to the larger weight, then the lower index. Zero weights get zero.
 * Negative totals (clawbacks) are the mirror image of the positive split.
 */
export function allocate(total: Minor, weights: number[]): Minor[] {
  assertMinor(total, "total");
  if (weights.length === 0) throw new RangeError("weights must not be empty");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new RangeError("weights must be non-negative safe integers");
  const sumW = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (sumW === 0n) throw new RangeError("weights must not all be zero");
  const neg = total < 0;
  const T = BigInt(neg ? -total : total);
  const base = weights.map((w) => (T * BigInt(w)) / sumW);
  const rem = weights.map((w, i) => ({ i, w, r: (T * BigInt(w)) % sumW }));
  let left = Number(T - base.reduce((a, b) => a + b, 0n));
  rem.sort((a, b) => (a.r === b.r ? (a.w === b.w ? a.i - b.i : b.w - a.w) : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (const { i, w } of rem) {
    if (left === 0) break;
    if (w === 0) continue;
    out[i]! += 1;
    left -= 1;
  }
  return neg ? out.map((x) => (x === 0 ? 0 : -x)) : out;
}

/** Cash rounding to the nearest `step` minor units (AU: 5), half away from zero. Only for cash tender totals. */
export function cashRound(amount: Minor, step = 5): Minor {
  assertMinor(amount);
  return Number(divRound(BigInt(amount), BigInt(step)) * BigInt(step));
}

export function formatMinor(amount: Minor, currency = "AUD", locale = "en-AU"): string {
  assertMinor(amount);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount / 100);
}
