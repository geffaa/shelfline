"""Independent reference for @shelfline/pricing golden vectors (exact rational arithmetic, no shared code with the TypeScript).
Run: python3 vectors/generate.py  -> vectors/vectors.json (200 cases, seeded)."""
import json, random
from fractions import Fraction
from math import floor

def half_up(x: Fraction) -> int:  # amounts here are never negative: half away from zero == half up
    return floor(x + Fraction(1, 2))

def allocate(total: int, weights: list[int]) -> list[int]:
    W = sum(weights); exact = [Fraction(total * w, W) for w in weights]
    base = [floor(e) for e in exact]; left = total - sum(base)
    order = sorted(range(len(weights)), key=lambda i: (-(exact[i] - base[i]), -weights[i], i))
    out = base[:]
    for i in order:
        if left == 0: break
        if weights[i] == 0: continue
        out[i] += 1; left -= 1
    return out

def price(lines, step):
    net = [l["unitPriceMinor"] * l["qty"] - l["discountMinor"] for l in lines]
    groups = {}
    for i, l in enumerate(lines): groups.setdefault((l["rateBp"], l["inclusive"]), []).append(i)
    tax = [0] * len(lines); total = [0] * len(lines)
    for (bp, incl), idx in groups.items():
        base = sum(net[i] for i in idx); r = Fraction(bp, 10000)
        gt = half_up(Fraction(base) * r / (1 + r)) if incl else half_up(Fraction(base) * r)
        parts = [0] * len(idx) if base == 0 or gt == 0 else allocate(gt, [net[i] for i in idx])
        for j, i in enumerate(idx):
            tax[i] = parts[j]; total[i] = net[i] if incl else net[i] + parts[j]
    T = sum(total); rounding = 0
    if step: rounding = half_up(Fraction(T, step)) * step - T
    return {"lines": [{"totalMinor": total[i], "taxMinor": tax[i]} for i in range(len(lines))],
            "subtotalMinor": sum(l["unitPriceMinor"] * l["qty"] for l in lines), "discountMinor": sum(l["discountMinor"] for l in lines),
            "taxMinor": sum(tax), "totalMinor": T, "cashRoundingMinor": rounding, "payableMinor": T + rounding}

def L(u, q=1, d=0, bp=1000, incl=True): return {"unitPriceMinor": u, "qty": q, "discountMinor": d, "rateBp": bp, "inclusive": incl}

cases = [
  ("sample cart from SCREENS S03: A$368.05 incl. GST A$33.46", [L(21995), L(8900, 1, 890), L(3400, 2)], None),
  ("single GST-inclusive item", [L(21995)], None),
  ("GST-free item", [L(2500, 1, 0, 0)], None),
  ("exclusive price adds GST", [L(10000, 1, 0, 1000, False)], None),
  ("100% discount", [L(5000, 1, 5000)], None),
  ("zero-priced line", [L(0, 3)], None),
  ("mixed inclusive, exclusive and GST-free", [L(9999, 2), L(4550, 1, 0, 1000, False), L(1200, 1, 0, 0)], None),
  ("cash rounding to 5c up", [L(36803, 1, 0, 0)], 5), ("cash rounding to 5c down", [L(36802, 1, 0, 0)], 5),
  ("tax remainder spread over three equal lines", [L(333), L(333), L(333)], None),
  ("large quantity", [L(1999, 500)], None),
]
rng = random.Random(20261104)
while len(cases) < 200:
    n = rng.randint(1, 8); lines = []
    for _ in range(n):
        u = rng.choice([rng.randint(1, 500), rng.randint(500, 30000), rng.randint(30000, 400000)]); q = rng.randint(1, 12)
        d = 0 if rng.random() < .55 else rng.randint(0, u * q)
        lines.append(L(u, q, d, rng.choice([0, 500, 1000, 1000, 1500, 2000]), rng.random() < .75))
    cases.append((f"random {len(cases)}", lines, rng.choice([None, None, 5, 10])))

out = [{"name": n, "input": {"lines": ls, "cashRoundingStep": st}, "expected": price(ls, st)} for n, ls, st in cases]
json.dump(out, open("vectors/vectors.json", "w"), indent=1)
s = out[0]["expected"]; assert (s["totalMinor"], s["taxMinor"]) == (36805, 3346), s
print(len(out), "vectors")
