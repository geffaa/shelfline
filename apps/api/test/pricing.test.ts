import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { priceCart } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); w = await posWorld(h, { stock: 50 }); });
const A = () => w.v[0]!.id, B = () => w.v[1]!.id;
const today = () => new Date().toISOString().slice(0, 10); const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const book = async (o: object = {}) => (await w.hqApi.post("/price-books", { name: `Book ${randomUUID().slice(0, 4)}`, ...o })).body;
const priced = async (id: string, set: [string, number][]) => (await w.hqApi.put(`/price-books/${id}/entries`, { set: set.map(([variantId, priceMinor]) => ({ variantId, priceMinor })) }));
const promo = async (o: object = {}) => { const r = await w.hqApi.post("/promotions", { name: `Promo ${randomUUID().slice(0, 4)}`, kind: "percent", valueBp: 1000, ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
const posGet = (path: string) => h.http().get(path).set("Authorization", `Bearer ${w.tok}`);
const snapshot = async () => { let r = (await posGet("/sync/snapshot")).body; let items = [...r.items]; let next = r.next; while (next) { r = (await posGet(`/sync/snapshot?after=${encodeURIComponent(next)}`)).body; items = items.concat(r.items); next = r.next; } return items as { type: string; id: string; data: any }[]; };

/** A sale as the till sends it: price lines (book price and promotion already applied), attach totals. */
async function sell(lines: { variantId: string; qty: number; unitPriceMinor: number; priceBookId?: string | null; promoDiscountMinor?: number; promotionIds?: string[]; discountMinor?: number }[], o: { pricingVersion?: number } = {}) {
  const sid = randomUUID(); expect((await w.push([w.cmd("session.open", { sessionId: sid, openingFloatMinor: 10000 })])).status).toBe(200);
  const ls = lines.map((l) => ({ ...l, discountMinor: (l.discountMinor ?? 0) + (l.promoDiscountMinor ?? 0) })); const pc = priceCart(ls.map((l) => ({ unitPriceMinor: l.unitPriceMinor, qty: l.qty, discountMinor: l.discountMinor, tax: { rateBp: 1000, inclusive: true } })));
  const r = await w.push([w.cmd("sale.create", { saleId: randomUUID(), sessionId: sid, receiptNo: `FIT-${randomUUID().slice(0, 6)}`, customerId: null, lines: ls, payments: [{ tender: "card", amountMinor: pc.payableMinor }],
    totals: { subtotalMinor: pc.subtotalMinor, discountMinor: pc.discountMinor, taxMinor: pc.taxMinor, totalMinor: pc.totalMinor, roundingMinor: 0, payableMinor: pc.payableMinor }, cashRoundingStep: null, ...o })]);
  return r.body.results[0] as { status: string; flags?: string[] };
}

describe("price books", () => {
  it("are created, scoped, edited and archived; names are unique; every change moves the version; only pricing roles may write", async () => {
    const b = await book({ name: "Spring", priority: 50, validFrom: today(), validTo: addDays(30), locationIds: [w.fitzroy.id] });
    expect(b).toMatchObject({ name: "Spring", priority: 50, version: 1 }); expect((await w.hqApi.post("/price-books", { name: "spring" })).status).toBe(409);
    expect((await w.hqApi.post("/price-books", { name: "Bad", validFrom: "2026-12-31", validTo: "2026-01-01" })).status).toBe(400); expect((await w.hqApi.post("/price-books", { name: "Away", locationIds: [randomUUID()] })).status).toBe(404);
    expect((await priced(b.id, [[A(), 19900], [B(), 7900]])).body).toMatchObject({ version: 2, set: 2 }); expect((await w.hqApi.put(`/price-books/${b.id}/entries`, { set: [], remove: [B()] })).body).toMatchObject({ version: 3, removed: 1 });
    const g = (await w.hqApi.get(`/price-books/${b.id}`)).body; expect(g).toMatchObject({ locations: [{ name: "Fitzroy" }], entries: [{ variantId: A(), priceMinor: 19900, basePriceMinor: 21995 }] });
    expect((await w.hqApi.patch(`/price-books/${b.id}`, { priority: 80, locationIds: [] })).body).toMatchObject({ priority: 80, version: 4 }); expect((await w.hqApi.get("/price-books")).body[0]).toMatchObject({ name: "Spring", entries: 1, places: [] });
    expect((await w.mgr.get("/price-books")).status).toBe(403); expect((await w.mgr.post("/price-books", { name: "x" })).status).toBe(403); expect((await w.hqApi.put(`/price-books/${b.id}/entries`, { set: [{ variantId: randomUUID(), priceMinor: 1 }] })).status).toBe(404);
    expect((await w.hqApi.patch(`/price-books/${b.id}`, { status: "archived" })).body.status).toBe("archived"); expect((await w.owner.get("/audit?action=price_book.entries")).body.length).toBeGreaterThan(0);
  });
  it("the preview resolves exactly as the till does: priority, dates and location scope", async () => {
    const wide = await book({ name: "Everywhere", priority: 10 }); await priced(wide.id, [[A(), 20000]]);
    const fit = await book({ name: "Fitzroy only", priority: 50, locationIds: [w.fitzroy.id] }); await priced(fit.id, [[A(), 18000]]);
    const later = await book({ name: "Next month", priority: 90, validFrom: addDays(10) }); await priced(later.id, [[A(), 15000]]);
    const q = (loc: string, on = today()) => w.hqApi.get(`/pricing/preview?variantId=${A()}&locationId=${loc}&onDate=${on}`).then((r) => r.body);
    expect(await q(w.fitzroy.id)).toMatchObject({ unitPriceMinor: 18000, priceBookId: fit.id, basePriceMinor: 21995 });
    expect(await q(w.southYarra.id)).toMatchObject({ unitPriceMinor: 20000, priceBookId: wide.id }); expect(await q(w.fitzroy.id, addDays(10))).toMatchObject({ unitPriceMinor: 15000, priceBookId: later.id });
    expect((await w.hqApi.get(`/pricing/preview?variantId=${B()}&locationId=${w.fitzroy.id}&onDate=${today()}`)).body).toMatchObject({ unitPriceMinor: 8900, priceBookId: null });
  });
});

describe("promotions", () => {
  it("validate their shape, apply by variant and minimum quantity, and the best single one beats the rest while stackable ones add", async () => {
    expect((await w.hqApi.post("/promotions", { name: "Bad", kind: "percent", valueBp: 0 })).status).toBe(400); expect((await w.hqApi.post("/promotions", { name: "Bad2", kind: "amount_off", amountMinor: 0 })).status).toBe(400);
    expect((await w.hqApi.post("/promotions", { name: "Bad3", kind: "percent", valueBp: 1000, amountMinor: 500 })).status).toBe(400);
    const ten = await promo({ name: "10 off", valueBp: 1000 }); await promo({ name: "Tees only", kind: "amount_off", valueBp: 0, amountMinor: 500, variantIds: [B()], minQty: 2 }); await promo({ name: "Loyalty", valueBp: 500, stackable: true });
    const q = (v: string, qty: number) => w.hqApi.get(`/pricing/preview?variantId=${v}&locationId=${w.fitzroy.id}&onDate=${today()}&qty=${qty}`).then((r) => r.body);
    expect((await q(A(), 1)).promoDiscountMinor).toBe(Math.round(21995 * 0.1) + Math.round(21995 * 0.05));              // 10% (best single) + 5% (stackable)
    expect((await q(B(), 2)).promoDiscountMinor).toBe(Math.max(Math.round(17800 * 0.1), 1000) + Math.round(17800 * 0.05));  // 1780 vs 2 x 5.00 = 1000: percent wins
    expect((await w.hqApi.patch(`/promotions/${ten.id}`, { status: "archived" })).body.version).toBe(2); expect((await q(A(), 1)).promoDiscountMinor).toBe(Math.round(21995 * 0.05));
    expect((await w.hqApi.patch(`/promotions/${ten.id}`, { kind: "amount_off" })).status).toBe(400); expect((await w.mgr.get("/promotions")).status).toBe(403);
    expect((await w.hqApi.get("/promotions")).body.map((p: any) => p.name).sort()).toEqual(["10 off", "Loyalty", "Tees only"]); expect((await w.hqApi.get(`/promotions/${ten.id}`)).body).toMatchObject({ name: "10 off", status: "archived" });
  });
});

describe("replication to the till", () => {
  it("the snapshot carries only this location's books, their entries and promotions; a change arrives on the next pull; an archived book disappears", async () => {
    const fit = await book({ name: "Fitzroy only", locationIds: [w.fitzroy.id] }); const sya = await book({ name: "South Yarra only", locationIds: [w.southYarra.id] }); const all = await book({ name: "Everywhere" });
    await priced(fit.id, [[A(), 100]]); await priced(sya.id, [[A(), 200]]); await priced(all.id, [[A(), 300], [B(), 400]]);
    await promo({ name: "Everywhere promo", variantIds: [A()] }); await promo({ name: "Yarra promo", locationIds: [w.southYarra.id] });
    const snap = await snapshot(); const ids = (t: string) => snap.filter((i) => i.type === t).map((i) => i.id).sort();
    expect(ids("price_book")).toEqual([fit.id, all.id].sort()); expect(ids("price_book_entry")).toEqual([`${fit.id}:${A()}`, `${all.id}:${A()}`, `${all.id}:${B()}`].sort());
    expect(snap.filter((i) => i.type === "promotion")).toMatchObject([{ data: { name: "Everywhere promo", variantIds: [A()], kind: "percent", valueBp: 1000 } }]);
    const first = (await posGet("/sync/snapshot")).body; let cursor: string = first.cursor; const drain = async () => { const r = (await posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body; cursor = r.cursor; return r.items as { type: string; id: string; op: string; data?: any }[]; };
    await drain(); await priced(fit.id, [[A(), 150]]);
    let it = await drain(); expect(it.find((i) => i.type === "price_book_entry")).toMatchObject({ id: `${fit.id}:${A()}`, op: "upsert", data: { priceMinor: 150 } }); expect(it.find((i) => i.type === "price_book")).toMatchObject({ id: fit.id, data: { version: 3 } });
    await w.hqApi.patch(`/price-books/${fit.id}`, { status: "archived" }); it = await drain(); expect(it.find((i) => i.type === "price_book")).toEqual({ type: "price_book", id: fit.id, op: "delete" });
    await priced(sya.id, [[B(), 250]]); expect((await drain()).every((i) => i.op === "delete")).toBe(true);   // another store's book never reaches this till (at most tombstones for things it never held)
    await w.hqApi.put(`/price-books/${all.id}/entries`, { set: [], remove: [B()] }); expect(await drain()).toEqual(expect.arrayContaining([{ type: "price_book_entry", id: `${all.id}:${B()}`, op: "delete" }]));
    await w.hqApi.patch(`/price-books/${sya.id}`, { locationIds: [w.fitzroy.id, w.southYarra.id] }); it = await drain(); expect(it.find((i) => i.type === "price_book" && i.id === sya.id)).toMatchObject({ op: "upsert" });   // scope widened: it arrives
  });
});

describe("selling with books and promotions", () => {
  it("a sale at the book price and promotion keeps the book, the promotion and the split of the discount; nothing is flagged", async () => {
    const b = await book({ name: "Autumn", priority: 20 }); await priced(b.id, [[A(), 19900]]); const p = await promo({ name: "5 off tees", kind: "amount_off", valueBp: 0, amountMinor: 500, variantIds: [A()] });
    const r = await sell([{ variantId: A(), qty: 2, unitPriceMinor: 19900, priceBookId: b.id, promoDiscountMinor: 1000, promotionIds: [p.id] }], { pricingVersion: 2 }); expect(r).toMatchObject({ status: "accepted" }); expect(r.flags ?? []).toEqual([]);
    const [l] = (await h.db.execute(sql`select price_book_id, promo_discount_minor::int as pd, discount_minor::int as d, promotion_ids, total_minor::int as t from shelfline.sale_line`)).rows as any[]; expect(l).toMatchObject({ price_book_id: b.id, pd: 1000, d: 1000, promotion_ids: [p.id], t: 38800 });
    const [s] = (await h.db.execute(sql`select price_snapshot from shelfline.sale`)).rows as any[]; expect(s.price_snapshot).toMatchObject({ pricingVersion: 2, serverPricingVersion: 2 });
  });
  it("a promotion's discount needs no manager approval, but a cashier's own discount over the limit still does", async () => {
    const p = await promo({ name: "Half off", valueBp: 5000, variantIds: [A()] });
    expect(((await sell([{ variantId: A(), qty: 1, unitPriceMinor: 21995, promoDiscountMinor: 10998, promotionIds: [p.id] }])).flags ?? [])).toEqual([]);
    const x = await sell([{ variantId: A(), qty: 1, unitPriceMinor: 21995, promoDiscountMinor: 10998, promotionIds: [p.id], discountMinor: 5000 }]); expect(x).toMatchObject({ status: "accepted_flagged" }); expect(x.flags).toEqual(["discount_unapproved"]);
  });
  it("a till that priced from an older book is accepted and flagged with both versions; a promotion it did not know of is flagged the same way", async () => {
    const b = await book({ name: "New price", priority: 20 }); await priced(b.id, [[A(), 18000]]);
    const old = await sell([{ variantId: A(), qty: 1, unitPriceMinor: 21995 }], { pricingVersion: 0 }); expect(old).toMatchObject({ status: "accepted_flagged", flags: ["price_book_mismatch"] });
    const ex = (await h.db.execute(sql`select detail from shelfline.sync_exception where kind = 'price_book_mismatch'`)).rows[0] as any; expect(ex.detail).toMatchObject({ lines: [{ i: 0, sent: 21995, server: 18000 }], devicePricingVersion: 0, serverPricingVersion: 2 });
    await promo({ name: "Surprise", valueBp: 1000, variantIds: [B()] }); const r = await sell([{ variantId: B(), qty: 1, unitPriceMinor: 8900 }], { pricingVersion: 2 });
    expect(r.flags).toEqual(["promo_mismatch"]); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sale`)).rows[0]).toMatchObject({ n: 2 });          // both sales stand
    expect((await sell([{ variantId: B(), qty: 1, unitPriceMinor: 8900, promoDiscountMinor: 890 }])).flags ?? []).toEqual([]);
  });
});
