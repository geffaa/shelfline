"""Independent reference for pricing v2 (price-book resolution and promotions). Exact rational arithmetic, no shared code with the TypeScript.
Run: python3 vectors/generate_rules.py -> vectors/rules.json (240 cases, seeded)."""
import json, random
from fractions import Fraction
from math import floor

def half_up(x): return floor(Fraction(x) + Fraction(1, 2))
def in_win(f, t, d): return (f is None or f <= d) and (t is None or t >= d)

def resolve(variant, base, date, books):
    cands = [b for b in books if in_win(b["validFrom"], b["validTo"], date) and variant in b["prices"]]
    if not cands: return {"unitPriceMinor": base, "priceBookId": None}
    top = max(b["priority"] for b in cands)
    win = sorted([b for b in cands if b["priority"] == top], key=lambda b: b["id"])[0]
    return {"unitPriceMinor": win["prices"][variant], "priceBookId": win["id"]}

def promos_for(line, promos, date):
    value = line["unitPriceMinor"] * line["qty"]; solo = []; stack = []
    for p in promos:
        if not in_win(p["validFrom"], p["validTo"], date) or line["qty"] < p["minQty"]: continue
        if p["variantIds"] is not None and line["variantId"] not in p["variantIds"]: continue
        d = min(value, half_up(Fraction(value * p["valueBp"], 10000)) if p["kind"] == "percent" else p["amountMinor"] * line["qty"])
        if d <= 0: continue
        (stack if p["stackable"] else solo).append((p["id"], d))
    best = sorted(solo, key=lambda x: (-x[1], x[0]))[:1]
    ids = [b[0] for b in best] + sorted(i for i, _ in stack)
    return {"discountMinor": min(value, sum(b[1] for b in best) + sum(d for _, d in stack)), "promotionIds": ids}

def day(r):
    return f"2026-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}"

def gen():
    r = random.Random(20261104); out = []
    variants = [f"v{i}" for i in range(6)]
    for n in range(120):
        books = []
        for i in range(r.randint(0, 4)):
            a, b = sorted([day(r), day(r)])
            books.append({"id": f"b{r.randint(0, 9)}{i}", "priority": r.choice([10, 10, 20, 50, 100]), "validFrom": r.choice([None, a]), "validTo": r.choice([None, b]),
                          "prices": {v: r.randint(100, 40000) for v in variants if r.random() < 0.6}})
        v = r.choice(variants); base = r.randint(100, 50000); date = day(r)
        out.append({"kind": "price", "name": f"price-{n}", "input": {"variantId": v, "basePriceMinor": base, "onDate": date, "books": books}, "expected": resolve(v, base, date, books)})
    for n in range(120):
        promos = []
        for i in range(r.randint(0, 4)):
            a, b = sorted([day(r), day(r)]); kind = r.choice(["percent", "amount_off"])
            promos.append({"id": f"p{r.randint(0, 9)}{i}", "kind": kind, "valueBp": r.choice([500, 1000, 1500, 2000, 2500, 3333]) if kind == "percent" else 0, "amountMinor": r.randint(50, 3000) if kind == "amount_off" else 0,
                           "variantIds": r.choice([None, r.sample(variants, r.randint(1, 4))]), "minQty": r.choice([1, 1, 2, 3]), "validFrom": r.choice([None, a]), "validTo": r.choice([None, b]), "stackable": r.random() < 0.35})
        lines = [{"variantId": r.choice(variants), "unitPriceMinor": r.randint(100, 40000), "qty": r.randint(1, 6)} for _ in range(r.randint(1, 4))]
        date = day(r)
        out.append({"kind": "promo", "name": f"promo-{n}", "input": {"lines": lines, "promos": promos, "onDate": date}, "expected": [promos_for(l, promos, date) for l in lines]})
    return out

if __name__ == "__main__":
    v = gen(); json.dump(v, open("vectors/rules.json", "w"), indent=1); print(len(v), "vectors")
