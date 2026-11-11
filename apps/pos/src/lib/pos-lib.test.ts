import { describe, expect, it } from "vitest";
import { SaleCreate } from "@shelfline/contracts";
import { MemoryStore } from "@shelfline/sync-client";
import { addVariant, approveLine, emptyCart, itemCount, linesNeedingApproval, priceOf, removeLine, setDiscount, setQty } from "./cart";
import { Catalogue } from "./catalogue";
import { fmt, parseMoney } from "./format";
import { completeSale, pendingSold, receiptNo, type LocalSession } from "./sales";

const GST = { rateBp: 1000, inclusive: true };
const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", basePriceMinor: 21995 }, B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", basePriceMinor: 8900 }, C = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", basePriceMinor: 3400 };

describe("cart", () => {
  it("scanning the same variant twice bumps the quantity; a discounted line stays separate", () => {
    let c = addVariant(emptyCart(), A); c = addVariant(c, A); expect(c.lines).toHaveLength(1); expect(c.lines[0]!.qty).toBe(2);
    c = setDiscount(c, c.lines[0]!.key, 500); c = addVariant(c, A); expect(c.lines).toHaveLength(2); expect(itemCount(c)).toBe(3);
  });
  it("quantity 0 removes; remove works; quantity is capped at 999", () => {
    let c = addVariant(emptyCart(), A); const k = c.lines[0]!.key; c = setQty(c, k, 5000); expect(c.lines[0]!.qty).toBe(999);
    expect(setQty(c, k, 0).lines).toHaveLength(0); expect(removeLine(c, k).lines).toHaveLength(0);
  });
  it("prices the sample cart of SCREENS S03 exactly: A$368.05 with A$33.46 GST", () => {
    let c = emptyCart(); c = addVariant(c, A); c = addVariant(c, B); c = addVariant(c, C, 2);
    c = setDiscount(c, c.lines[1]!.key, 1000, "friends and family");
    const { result, discounts } = priceOf(c, () => GST);
    expect(discounts).toEqual([0, 890, 0]); expect(result).toMatchObject({ subtotalMinor: 37695, discountMinor: 890, taxMinor: 3346, totalMinor: 36805, payableMinor: 36805 });
  });
  it("a percentage discount follows the quantity", () => { let c = addVariant(emptyCart(), B); c = setDiscount(c, c.lines[0]!.key, 1000); c = setQty(c, c.lines[0]!.key, 3); expect(priceOf(c, () => GST).discounts).toEqual([2670]); });
  it("discounts over the cashier limit need approval until a manager approves; managers and 0% never do", () => {
    let c = addVariant(emptyCart(), A); const k = c.lines[0]!.key;
    c = setDiscount(c, k, 1500, "price match"); expect(linesNeedingApproval(c, 1000, false)).toHaveLength(1); expect(linesNeedingApproval(c, 1000, true)).toHaveLength(0);
    c = approveLine(c, k, "tok", "Marcus T."); expect(linesNeedingApproval(c, 1000, false)).toHaveLength(0);
    c = setDiscount(c, k, 0); expect(c.lines[0]).toMatchObject({ approvalToken: undefined, discountBp: 0 });
    expect(linesNeedingApproval(setDiscount(c, k, 1000), 1000, false)).toHaveLength(0);       // exactly at the limit is allowed
    expect(() => setDiscount(c, k, 10001)).toThrow();
  });
  it("cash rounding is a separate amount that only appears with a step", () => {
    const c = addVariant(emptyCart(), { id: A.id, basePriceMinor: 3403 });
    expect(priceOf(c, () => ({ rateBp: 0, inclusive: true }), 5).result).toMatchObject({ totalMinor: 3403, cashRoundingMinor: 2, payableMinor: 3405 });
    expect(priceOf(c, () => ({ rateBp: 0, inclusive: true })).result.cashRoundingMinor).toBe(0);
  });
});

describe("format", () => {
  it("formats minor units and parses typed amounts without floats", () => { expect(fmt(36805)).toBe("A$368.05"); expect(fmt(-500)).toBe("-A$5.00"); expect(parseMoney("12.5")).toBe(1250); expect(parseMoney("1.15")).toBe(115); expect(parseMoney("1.005")).toBeNull(); expect(parseMoney("")).toBeNull(); });
});

async function seeded() {
  const s = new MemoryStore();
  const loc = "11111111-1111-4111-8111-111111111111";
  await s.transact((tx) => tx.applyItems([
    { type: "location", id: loc, op: "upsert", data: { id: loc, code: "FIT", name: "Fitzroy", timezone: "Australia/Melbourne", dayCutoff: "04:00:00", taxRegion: "AU-WA", cashierDiscountLimitBp: 1000 } },
    { type: "register", id: "r1", op: "upsert", data: { id: "r1", code: "FIT-2", name: "Front desk" } },
    { type: "product", id: "p1", op: "upsert", data: { id: "p1", title: "Tempra Glide 3", brand: "Tempra", taxClassId: "tc", status: "active" } },
    { type: "product", id: "p2", op: "upsert", data: { id: "p2", title: "Merino tee", brand: null, taxClassId: "tc", status: "active" } },
    { type: "variant", id: A.id, op: "upsert", data: { id: A.id, productId: "p1", sku: "TG3-M-105-BW", barcode: "9300000100105", options: { size: "10.5", colour: "Black/White" }, basePriceMinor: 21995, trackStock: true, status: "active" } },
    { type: "variant", id: B.id, op: "upsert", data: { id: B.id, productId: "p2", sku: "MT-M-SLATE", barcode: null, options: { size: "M", colour: "Slate" }, basePriceMinor: 8900, trackStock: true, status: "active" } },
    { type: "variant", id: C.id, op: "upsert", data: { id: C.id, productId: "p2", sku: "OLD-1", barcode: null, options: {}, basePriceMinor: 100, trackStock: false, status: "archived" } },
    { type: "stock_balance", id: `${A.id}:${loc}`, op: "upsert", data: { variantId: A.id, locationId: loc, onHand: 6 } },
    { type: "tax_rate", id: "t1", op: "upsert", data: { id: "t1", taxClassId: "tc", region: null, rateBp: 1000, inclusive: true, validFrom: "2000-07-01", validTo: null } },
    { type: "tax_rate", id: "t2", op: "upsert", data: { id: "t2", taxClassId: "tc", region: "AU-WA", rateBp: 1200, inclusive: true, validFrom: "2026-01-01", validTo: "2027-01-01" } },
    { type: "customer", id: "c1", op: "upsert", data: { id: "c1", name: "Sam Okafor", email: "sam@example.test", phone: "0400 000 111" } },
  ]));
  return s;
}
describe("price books and promotions on the till (offline, from the last sync)", () => {
  const apply = (s: MemoryStore) => s.transact((tx) => tx.applyItems([
    { type: "price_book", id: "11111111-1111-4111-8111-111111111111", op: "upsert", data: { id: "11111111-1111-4111-8111-111111111111", name: "Spring", priority: 50, validFrom: "2026-09-01", validTo: "2026-12-31", version: 3 } },
    { type: "price_book", id: "22222222-2222-4222-8222-222222222222", op: "upsert", data: { id: "22222222-2222-4222-8222-222222222222", name: "Base", priority: 10, validFrom: null, validTo: null, version: 1 } },
    { type: "price_book_entry", id: `11111111-1111-4111-8111-111111111111:${A.id}`, op: "upsert", data: { bookId: "11111111-1111-4111-8111-111111111111", variantId: A.id, priceMinor: 19900 } }, { type: "price_book_entry", id: `22222222-2222-4222-8222-222222222222:${A.id}`, op: "upsert", data: { bookId: "22222222-2222-4222-8222-222222222222", variantId: A.id, priceMinor: 20900 } },
    { type: "price_book_entry", id: `55555555-5555-4555-8555-555555555555:${A.id}`, op: "upsert", data: { bookId: "55555555-5555-4555-8555-555555555555", variantId: A.id, priceMinor: 1 } },
    { type: "promotion", id: "33333333-3333-4333-8333-333333333333", op: "upsert", data: { id: "33333333-3333-4333-8333-333333333333", name: "Tees 10%", kind: "percent", valueBp: 1000, amountMinor: 0, minQty: 1, stackable: false, validFrom: null, validTo: null, version: 7, variantIds: [A.id] } },
  ]));
  it("resolves the winning book by date, ignores entries of books it does not hold, and reports the newest version it knows", async () => {
    const s = await seeded(); await apply(s); const cat = await Catalogue.load(s);
    expect(cat.priceFor(A.id, "2026-11-04")).toEqual({ unitPriceMinor: 19900, priceBookId: "11111111-1111-4111-8111-111111111111" }); expect(cat.priceFor(A.id, "2027-02-01")).toEqual({ unitPriceMinor: 20900, priceBookId: "22222222-2222-4222-8222-222222222222" });
    expect(cat.priceFor(B.id, "2026-11-04")).toEqual({ unitPriceMinor: B.basePriceMinor, priceBookId: null }); expect(cat.pricingVersion).toBe(7);
    expect(cat.promotionsFor([{ variantId: A.id, unitPriceMinor: 19900, qty: 2 }], "2026-11-04")).toEqual([{ discountMinor: 3980, promotionIds: ["33333333-3333-4333-8333-333333333333"] }]);
  });
  it("a sale carries the book, the promotion part of the discount separately from the cashier's, and the pricing version it priced with", async () => {
  const session: LocalSession = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", openedAt: "2026-11-04T08:57:00Z", openingFloatMinor: 30000, cashierId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", cashierName: "Priya N." };
    const s = await seeded(); await apply(s); const cat = await Catalogue.load(s); const price = cat.priceFor(A.id, "2026-11-04");
    let cart = addVariant(emptyCart(), A, 2, price); cart = setDiscount(cart, cart.lines[0]!.key, 500, "staff");
    const priced = priceOf(cart, (v) => cat.taxRuleFor(v, "2026-11-04"), null, (ls) => cat.promotionsFor(ls, "2026-11-04"));
    expect(priced.promos[0]!.discountMinor).toBe(3980); expect(priced.discounts[0]).toBe(3980 + 1990);                      // 10% promotion + 5% cashier discount, both on the line value
    const sale = await completeSale(s, { cart, priced, payments: [{ tender: "card", amountMinor: priced.result.payableMinor }], cashRoundingStep: null, session, cashier: { id: session.cashierId, name: "P" }, register: { id: "r1", code: "FIT-2" }, customer: null, variants: cat.variants, pricingVersion: cat.pricingVersion });
    const cmd = (await s.pendingCommands(5)).find((c) => c.type === "sale.create")!; const p = cmd.payload as any;
    expect(p.pricingVersion).toBe(7); expect(p.lines[0]).toMatchObject({ unitPriceMinor: 19900, priceBookId: "11111111-1111-4111-8111-111111111111", promoDiscountMinor: 3980, promotionIds: ["33333333-3333-4333-8333-333333333333"], discountMinor: 5970 }); expect(sale.lines[0]!.discountMinor).toBe(5970);
  });
  it("the cashier's discount cannot push the line below zero once a promotion has taken its share", async () => {
    const s = await seeded(); await s.transact((tx) => tx.applyItems([{ type: "promotion", id: "44444444-4444-4444-8444-444444444444", op: "upsert", data: { id: "44444444-4444-4444-8444-444444444444", name: "95%", kind: "percent", valueBp: 9500, amountMinor: 0, minQty: 1, stackable: false, validFrom: null, validTo: null, version: 1, variantIds: null } }]));
    const cat = await Catalogue.load(s); let cart = addVariant(emptyCart(), B, 1); cart = setDiscount(cart, cart.lines[0]!.key, 2000, "staff");
    const priced = priceOf(cart, (v) => cat.taxRuleFor(v, "2026-11-04"), null, (ls) => cat.promotionsFor(ls, "2026-11-04")); expect(priced.discounts[0]).toBeLessThanOrEqual(B.basePriceMinor); expect(priced.result.lines[0]!.totalMinor).toBeGreaterThanOrEqual(0);
  });
});

describe("catalogue", () => {
  it("looks up by barcode and SKU, searches by words across title, brand, SKU and options, hides archived, ranks exact first", async () => {
    const cat = await Catalogue.load(await seeded());
    expect(cat.byCode("9300000100105")?.id).toBe(A.id); expect(cat.byCode(" tg3-m-105-bw ")?.id).toBe(A.id); expect(cat.byCode("nope")).toBeUndefined();
    expect(cat.search("glide 10.5").map((v) => v.id)).toEqual([A.id]); expect(cat.search("slate tee").map((v) => v.id)).toEqual([B.id]);
    expect(cat.search("old")).toEqual([]);                                                       // archived
    expect(cat.search("   ")).toEqual([]); expect(cat.search("zzz")).toEqual([]);
    expect(cat.search("tempra")[0]!.optionsLabel).toBe("10.5 · Black/White");
  });
  it("shows stock as of the last sync minus what this till has sold since; untracked variants have no count", async () => {
    const s = await seeded(); const cat = await Catalogue.load(s, new Map([[A.id, 2]]));
    expect(cat.variants.get(A.id)!.onHand).toBe(4); expect(cat.variants.get(B.id)!.onHand).toBe(0 - 0); expect(cat.variants.get(C.id)!.onHand).toBeNull();
  });
  it("shows this iPad's own register, not just the first register of the store", async () => {
    const s = await seeded(); await s.transact((tx) => tx.applyItems([{ type: "register", id: "r0", op: "upsert", data: { id: "r0", code: "FIT-1", name: "Side desk" } }]));
    expect((await Catalogue.load(s, new Map(), "r1")).register?.code).toBe("FIT-2"); expect((await Catalogue.load(s, new Map(), "r0")).register?.code).toBe("FIT-1");
    expect((await Catalogue.load(s, new Map(), "unknown")).register).toBeNull();
  });
  it("resolves the tax rule for the location's region and the business date", async () => {
    const cat = await Catalogue.load(await seeded());
    expect(cat.taxRuleFor(A.id, "2026-06-01")).toEqual({ rateBp: 1200, inclusive: true }); expect(cat.taxRuleFor(A.id, "2027-06-01")).toEqual({ rateBp: 1000, inclusive: true });
    expect(cat.location).toMatchObject({ code: "FIT", cashierDiscountLimitBp: 1000 }); expect(cat.register?.code).toBe("FIT-2");
  });
  it("finds customers by name, email or phone", async () => { const cat = await Catalogue.load(await seeded()); expect(cat.searchCustomers("okafor")).toHaveLength(1); expect(cat.searchCustomers("0400")).toHaveLength(1); expect(cat.searchCustomers("")).toHaveLength(1); expect(cat.searchCustomers("zz")).toEqual([]); });
});

describe("completeSale", () => {
  const session: LocalSession = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", openedAt: "2026-11-04T08:57:00Z", openingFloatMinor: 30000, cashierId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", cashierName: "Priya N." };
  async function sell(s: MemoryStore, cat: Catalogue, qty = 1) {
    let cart = addVariant(emptyCart(), A, qty); cart = addVariant(cart, B);
    const priced = priceOf(cart, (v) => cat.taxRuleFor(v, "2027-06-01"));
    return completeSale(s, { cart, priced, cashRoundingStep: null, payments: [{ tender: "card", amountMinor: priced.result.payableMinor }], session, cashier: { id: session.cashierId, name: session.cashierName }, register: { id: "r1", code: "FIT-2" }, customer: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "Sam Okafor" }, variants: cat.variants });
  }
  it("writes the receipt and the queued command together; receipt numbers are gapless per register; the payload satisfies the server's schema", async () => {
    const s = await seeded(); const cat = await Catalogue.load(s);
    const r1 = await sell(s, cat), r2 = await sell(s, cat);
    expect([r1.receiptNo, r2.receiptNo]).toEqual(["FIT-2-000001", "FIT-2-000002"]); expect(receiptNo("FIT-2", 7)).toBe("FIT-2-000007");
    const q = await s.pendingCommands(10); expect(q.map((c) => c.type)).toEqual(["sale.create", "sale.create"]); expect(q.map((c) => c.seq)).toEqual([1, 2]);
    expect(SaleCreate.safeParse(q[0]!.payload).success).toBe(true);
    expect((await s.get("sales", r1.id))).toMatchObject({ receiptNo: "FIT-2-000001", totals: { totalMinor: 30895 }, customerName: "Sam Okafor" });
    expect((q[0]!.payload as { totals: { payableMinor: number } }).totals.payableMinor).toBe(30895);
  });
  it("is all-or-nothing: a payload the server would refuse leaves no receipt, no command, and does not burn a receipt number", async () => {
    const s = await seeded(); const cat = await Catalogue.load(s); await sell(s, cat);
    let cart = addVariant(emptyCart(), A); const priced = priceOf(cart, () => GST); cart = { ...cart };
    await expect(completeSale(s, { cart, priced, cashRoundingStep: null, payments: [{ tender: "card", amountMinor: 0 }], session, cashier: { id: session.cashierId, name: "P" }, register: { id: "r1", code: "FIT-2" }, customer: null, variants: cat.variants })).rejects.toThrow();
    expect(await s.pendingCount()).toBe(1); expect(await s.getMeta("receiptSeq:r1")).toBe("1"); expect((await s.list("sales")).length).toBe(1);
    expect((await sell(s, cat)).receiptNo).toBe("FIT-2-000002");
  });
  it("counts units sold but not yet acknowledged so the shelf count stays honest offline", async () => {
    const s = await seeded(); const cat = await Catalogue.load(s); await sell(s, cat, 2); await sell(s, cat, 1);
    const sold = await pendingSold(s); expect(sold.get(A.id)).toBe(3); expect(sold.get(B.id)).toBe(2);
    expect((await Catalogue.load(s, sold)).variants.get(A.id)!.onHand).toBe(3);
  });
});
