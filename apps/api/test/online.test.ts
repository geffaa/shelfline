import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { LedgerService } from "../src/inventory/ledger.service";
import { OnlineService } from "../src/online/online.service";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
const world = async (stock: number) => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.email_outbox, shelfline.online_order_line, shelfline.online_order restart identity cascade`); w = await posWorld(h, { stock });
  expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, { pickupEnabled: true })).status).toBe(200); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 10000 })]); await new Promise((r) => setTimeout(r, 300));       // let the background workers that react to the open finish before anything truncates
};
const shop = (p: string) => h.http().get(`/shop/${w.orgId}${p}`);
const order = (lines: { v: number; qty: number }[], o: object = {}) => h.http().post(`/shop/${w.orgId}/orders`).send({ email: `buyer${Math.random().toString(36).slice(2, 7)}@example.com`, name: "Sam Buyer", locationId: w.fitzroy.id, lines: lines.map((l) => ({ variantId: w.v[l.v]!.id, qty: l.qty })), ...o });
const onHand = async (v = 0, loc = w.fitzroy.id) => Number((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${w.v[v]!.id} and location_id = ${loc}`)).rows[0]?.on_hand ?? 0);
const mails = async (to?: string) => (await h.db.execute(sql`select to_email, subject, body, kind from shelfline.email_outbox ${to ? sql`where to_email = ${to}` : sql``} order by created_at`)).rows as { to_email: string; subject: string; body: string; kind: string }[];
const ledgerOk = async () => expect(await h.app.get(LedgerService).check(w.orgId)).toEqual([]);

describe("the shop window", () => {
  beforeEach(() => world(5));
  it("shows only the stores that take pickups, with what is in stock there", async () => {
    const s = (await shop("")).body; expect(s).toMatchObject({ name: "Kestrel Run Co.", currency: "AUD" }); expect(s.stores.map((x: { name: string }) => x.name)).toEqual(["Fitzroy"]);
    const { products } = (await shop("/products")).body; expect(products).toHaveLength(1); expect(products[0]).toMatchObject({ title: "Tempra Glide 3", fromPriceMinor: 3400, toPriceMinor: 21995, variants: 3, available: 15, inStock: true });
    await h.db.execute(sql`update shelfline.stock_balance set on_hand = 0`); expect((await shop("/products")).body.products[0]).toMatchObject({ available: 0, inStock: false });
  });
  it("lists variants with per-store availability, never negative, and only for stores that take pickups", async () => {
    await h.db.execute(sql`update shelfline.stock_balance set on_hand = -2 where variant_id = ${w.v[1]!.id}`); const sy = await w.owner.patch(`/locations/${w.southYarra.id}`, { pickupEnabled: true }); expect(sy.status).toBe(200);
    const p = (await shop(`/products/${w.p.id}`)).body; expect(p.stores.map((x: { name: string }) => x.name)).toEqual(["Fitzroy", "South Yarra"]);
    const v1 = p.variants.find((x: { id: string }) => x.id === w.v[1]!.id); expect(v1.availability).toEqual([{ locationId: w.fitzroy.id, store: "Fitzroy", available: 0 }, { locationId: w.southYarra.id, store: "South Yarra", available: 0 }]);
    expect(p.variants.find((x: { id: string }) => x.id === w.v[0]!.id).availability[0].available).toBe(5);
  });
  it("a storefront can be pointed at the only organisation, and refuses when there are several", async () => {
    expect((await h.http().get("/shop-default")).body).toEqual({ orgId: w.orgId }); await h.db.execute(sql`insert into shelfline.org (name, slug, currency, timezone_default) values ('Second', 'second', 'AUD', 'Australia/Perth')`); expect((await h.http().get("/shop-default")).status).toBe(404); expect((await h.http().get("/shop-default?slug=second")).body).toMatchObject({ orgId: expect.any(String) }); expect((await h.http().get("/shop-default?slug=kestrel-run-co")).body).toEqual({ orgId: w.orgId });
  });
  it("searches and filters, hides archived products, and says no when the shop or the product does not exist", async () => {
    const cat = (await w.hqApi.post("/categories", { name: "Socks" })).body; await w.hqApi.post("/products", { title: "Trail Socks", taxClassId: w.gst.id, categoryId: cat.id, brand: "Tempra", variants: [{ sku: "TS-1", basePriceMinor: 1500 }] });
    expect((await shop("/products?q=socks")).body.products.map((x: { title: string }) => x.title)).toEqual(["Trail Socks"]); expect((await shop(`/products?categoryId=${cat.id}`)).body.products).toHaveLength(1); expect((await shop("/products?q=nothing-like-this")).body.products).toEqual([]);
    expect((await shop("/products?q=%25")).body.products).toEqual([]);                                                       // a wildcard is not a search for everything
    await h.db.execute(sql`update shelfline.product set status = 'archived' where id = ${w.p.id}`); expect((await shop(`/products/${w.p.id}`)).status).toBe(404); expect((await shop("/products")).body.products.map((x: { title: string }) => x.title)).toEqual(["Trail Socks"]);
    expect((await h.http().get(`/shop/${randomUUID()}`)).status).toBe(404); expect((await shop(`/products/${randomUUID()}`)).status).toBe(404);
  });
});

describe("reserving stock", () => {
  beforeEach(() => world(10));
  it("reserves every line at the chosen store, prices it as the till would, and tells the customer how to collect", async () => {
    const r = await order([{ v: 0, qty: 1 }, { v: 1, qty: 2 }], { email: "sam@example.com" }); expect(r.status, JSON.stringify(r.body)).toBe(201);
    const priced = priceCart([{ qty: 1, unitPriceMinor: 21995, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }, { qty: 2, unitPriceMinor: 8900, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }]);
    expect(r.body).toMatchObject({ total: priced.totalMinor, store: "Fitzroy" }); expect(r.body.number).toMatch(/^ON-\d{6}$/); expect(r.body.pickupCode).toMatch(/^[2-9A-HJ-NP-Z]{6}$/); expect(r.body.accessToken).toHaveLength(36);
    expect(await onHand(0)).toBe(9); expect(await onHand(1)).toBe(8); await ledgerOk();
    expect((await h.db.execute(sql`select kind, qty_delta from shelfline.stock_movement where source_type = 'online_order' order by line_no`)).rows).toEqual([{ kind: "online_reserve", qty_delta: -1 }, { kind: "online_reserve", qty_delta: -2 }]);
    const m = (await mails("sam@example.com"))[0]!; expect(m.kind).toBe("online_order"); expect(m.body).toContain(r.body.pickupCode); expect(m.subject).toContain(r.body.number); expect(m.body).toContain(`${(priced.totalMinor / 100).toFixed(2)}`);
    const [row] = (await h.db.execute(sql`select pickup_code_hash, access_token_hash from shelfline.online_order`)).rows as { pickup_code_hash: string; access_token_hash: string }[]; expect(row!.pickup_code_hash).not.toContain(r.body.pickupCode); expect(row!.access_token_hash).not.toContain(r.body.accessToken);
  });
  it("two shoppers after the last pair: one gets it, the other is told how many are left, and stock never goes below zero", async () => {
    await world(1); const [a, b] = await Promise.all([order([{ v: 0, qty: 1 }]), order([{ v: 0, qty: 1 }])]); expect([a.status, b.status].sort()).toEqual([201, 409]);
    const lost = a.status === 409 ? a : b; expect(lost.body).toMatchObject({ code: "insufficient_stock", available: 0, wanted: 1, variantId: w.v[0]!.id }); expect(await onHand(0)).toBe(0); await ledgerOk(); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.online_order`)).rows[0]!.n).toBe(1);
    const won = a.status === 201 ? a : b; expect((await h.http().post(`/shop/${w.orgId}/orders/${won.body.id}/cancel?t=${won.body.accessToken}`)).body.status).toBe("cancelled"); expect((await order([{ v: 0, qty: 1 }])).status).toBe(201);          // given back, so the next one can have it
  });
  it("ten shoppers after five pairs: exactly five succeed", async () => {
    await world(5); const rs = await Promise.all(Array.from({ length: 10 }, () => order([{ v: 0, qty: 1 }]))); expect(rs.filter((r) => r.status === 201)).toHaveLength(5); expect(rs.filter((r) => r.status === 409)).toHaveLength(5); expect(await onHand(0)).toBe(0); await ledgerOk();
  });
  it("is all or nothing: one line short means nothing is reserved and no order exists", async () => {
    await world(3); const r = await order([{ v: 0, qty: 2 }, { v: 1, qty: 4 }]); expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: "insufficient_stock", variantId: w.v[1]!.id, available: 3 });
    expect(await onHand(0)).toBe(3); expect(await onHand(1)).toBe(3); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.online_order`)).rows[0]!.n).toBe(0); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.stock_movement where kind = 'online_reserve'`)).rows[0]!.n).toBe(0);
  });
  it("adds up repeated lines, and refuses stores that do not take pickups, unknown goods, empty carts and nonsense", async () => {
    expect((await order([{ v: 0, qty: 2 }, { v: 0, qty: 3 }])).status).toBe(201); expect(await onHand(0)).toBe(5);
    expect((await order([{ v: 0, qty: 1 }], { locationId: w.southYarra.id })).body).toMatchObject({ code: "store_not_available_for_pickup" }); expect((await order([{ v: 0, qty: 1 }], { locationId: randomUUID() })).status).toBe(409);
    expect((await h.http().post(`/shop/${w.orgId}/orders`).send({ email: "a@b.co", name: "A", locationId: w.fitzroy.id, lines: [{ variantId: randomUUID(), qty: 1 }] })).status).toBe(404);
    for (const bad of [{ lines: [] }, { email: "nope" }, { name: "" }, { lines: [{ variantId: w.v[0]!.id, qty: 0 }] }, { lines: [{ variantId: w.v[0]!.id, qty: 21 }] }, { lines: [{ variantId: "x", qty: 1 }] }]) expect([JSON.stringify(bad), (await h.http().post(`/shop/${w.orgId}/orders`).send({ email: "a@b.co", name: "A", locationId: w.fitzroy.id, lines: [{ variantId: w.v[0]!.id, qty: 1 }], ...bad })).status]).toEqual([JSON.stringify(bad), 400]);
    await ledgerOk();
  });
  it("is rate limited by email address", async () => {
    for (let i = 0; i < 5; i++) expect((await order([{ v: 2, qty: 1 }], { email: "same@example.com" })).status).toBe(201); expect((await order([{ v: 2, qty: 1 }], { email: "same@example.com" })).status).toBe(429); expect((await order([{ v: 2, qty: 1 }], { email: "other@example.com" })).status).toBe(201);
  });
  it("an order cannot be read without its link token, and finished orders cannot be rewritten or deleted", async () => {
    const r = await order([{ v: 0, qty: 1 }]); const url = `/shop/${w.orgId}/orders/${r.body.id}`;
    expect((await h.http().get(url)).status).toBe(404); expect((await h.http().get(url + "?t=wrong")).status).toBe(404); const view = (await h.http().get(`${url}?t=${r.body.accessToken}`)).body; expect(view).toMatchObject({ number: r.body.number, status: "placed", store: "Fitzroy", lines: [{ title: "Tempra Glide 3", qty: 1 }] }); expect(JSON.stringify(view)).not.toContain("@");
    await h.http().post(`${url}/cancel?t=${r.body.accessToken}`); await expect(h.db.execute(sql`update shelfline.online_order set status = 'placed' where id = ${r.body.id}`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.online_order`)).rejects.toThrow(); await expect(h.db.execute(sql`update shelfline.online_order_line set qty = 9`)).rejects.toThrow();
  });
});

describe("cancelling, expiring and the staff's view", () => {
  beforeEach(() => world(10));
  it("a cancellation gives the stock back once, however often it is asked", async () => {
    const r = await order([{ v: 0, qty: 3 }]); expect(await onHand(0)).toBe(7); const url = `/shop/${w.orgId}/orders/${r.body.id}/cancel?t=${r.body.accessToken}`;
    expect((await h.http().post(url)).body.status).toBe("cancelled"); expect((await h.http().post(url)).body.status).toBe("cancelled"); expect(await onHand(0)).toBe(10); await ledgerOk();
  });
  it("orders nobody collects expire after 48 hours and the stock comes back", async () => {
    const r = await order([{ v: 1, qty: 2 }]); const svc = h.app.get(OnlineService); expect(await svc.expireStale()).toBe(0);
    await h.db.execute(sql`alter table shelfline.online_order disable trigger online_order_guard`); await h.db.execute(sql`update shelfline.online_order set expires_at = now() - interval '1 minute'`); await h.db.execute(sql`alter table shelfline.online_order enable trigger online_order_guard`);
    expect(await svc.expireStale()).toBe(1); expect(await svc.expireStale()).toBe(0); expect(await onHand(1)).toBe(10); expect((await h.http().get(`/shop/${w.orgId}/orders/${r.body.id}?t=${r.body.accessToken}`)).body.status).toBe("expired"); await ledgerOk();
  });
  it("a manager sees this store's orders, marks one ready (the customer is emailed) or cancels it with a reason; other stores' managers and cashiers cannot", async () => {
    const r = await order([{ v: 0, qty: 1 }], { email: "ready@example.com" }); const list = (await w.mgr.get("/online-orders")).body; expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ number: r.body.number, status: "placed", store: "Fitzroy", customer: "Sam Buyer", lines: [{ title: "Tempra Glide 3", qty: 1 }] });
    expect((await w.mgr.post(`/online-orders/${r.body.id}/ready`)).body.status).toBe("ready"); expect((await w.mgr.post(`/online-orders/${r.body.id}/ready`)).body.status).toBe("ready"); expect((await mails("ready@example.com")).map((m) => m.kind)).toEqual(["online_order", "online_order_ready"]);
    const other = await w.owner.post("/users", { email: "sy@kestrel.test", name: "Sy", password: "south-yarra-pass-3", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] }); expect(other.status).toBe(201); const sy = w.as((await w.login("sy@kestrel.test", "south-yarra-pass-3")).body.token);
    expect((await sy.get("/online-orders")).body).toEqual([]); expect((await sy.post(`/online-orders/${r.body.id}/cancel`, { reason: "nope nope" })).status).toBe(403); expect((await w.mgr.post(`/online-orders/${r.body.id}/cancel`, { reason: "x" })).status).toBe(400);
    expect((await w.mgr.post(`/online-orders/${r.body.id}/cancel`, { reason: "Out of stock after a count" })).body.status).toBe("cancelled"); expect(await onHand(0)).toBe(10); expect((await w.mgr.post(`/online-orders/${r.body.id}/ready`)).status).toBe(409);
    expect((await h.http().get("/online-orders")).status).toBe(401); expect((await w.owner.get("/audit?action=online_order.cancel")).body).toHaveLength(1);
  });
});

describe("collecting at the till", () => {
  beforeEach(() => world(10));
  const saleFor = (lines: { v: number; qty: number }[], online?: string) => { const ls = lines.map((l) => ({ variantId: w.v[l.v]!.id, qty: l.qty, unitPriceMinor: [21995, 8900, 3400][l.v]!, discountMinor: 0 })); const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
    return { saleId, cmd: w.cmd("sale.create", { saleId, sessionId: session, receiptNo: `P-${saleId.slice(0, 6)}`, customerId: null, lines: ls, payments: [{ tender: "card", amountMinor: p.payableMinor }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null, ...(online ? { onlineOrderId: online } : {}) }) }; };
  const till = (path: string) => h.http().get(path).set("Authorization", `Bearer ${w.tok}`);
  it("looks the order up by its code at its own store, and the sale that collects it takes the goods out exactly once", async () => {
    const r = await order([{ v: 0, qty: 2 }, { v: 2, qty: 1 }]); expect(await onHand(0)).toBe(8);
    const found = (await till(`/pos/online-orders/lookup?code=${r.body.pickupCode.toLowerCase()}`)).body; expect(found).toMatchObject({ id: r.body.id, number: r.body.number, customer: "Sam Buyer", status: "placed" }); expect(found.lines).toHaveLength(2);
    expect((await till("/pos/online-orders/lookup?code=ZZZZZZ")).status).toBe(404); expect((await till("/pos/online-orders/lookup")).status).toBe(400); expect((await h.http().get(`/pos/online-orders/lookup?code=${r.body.pickupCode}`)).status).toBe(401);
    const s = saleFor([{ v: 0, qty: 2 }, { v: 2, qty: 1 }], r.body.id); const out = await w.push([s.cmd]); expect(out.body.results[0].status).toBe("accepted"); expect(out.body.results[0].flags ?? []).toEqual([]);
    expect(await onHand(0)).toBe(8); expect(await onHand(2)).toBe(9); await ledgerOk();                       // 10 - 2 once, not 10 - 2 - 2
    expect((await h.db.execute(sql`select status, sale_id from shelfline.online_order`)).rows[0]).toEqual({ status: "collected", sale_id: s.saleId }); expect((await till(`/pos/online-orders/lookup?code=${r.body.pickupCode}`)).status).toBe(404);
    expect((await h.db.execute(sql`select kind, qty_delta from shelfline.stock_movement where variant_id = ${w.v[0]!.id} and kind in ('online_reserve','online_release','sale') order by id`)).rows.map((x) => `${x.kind}:${x.qty_delta}`)).toEqual(["online_reserve:-2", "online_release:2", "sale:-2"]);
    expect((await w.mgr.post(`/online-orders/${r.body.id}/cancel`, { reason: "too late to cancel" })).status).toBe(409);
  });
  it("collecting a different basket is accepted but flagged; an unknown or finished order is flagged; nothing is double-released", async () => {
    const r = await order([{ v: 0, qty: 2 }]); const diff = await w.push([saleFor([{ v: 0, qty: 1 }], r.body.id).cmd]); expect(diff.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["online_order_differs"] }); expect(await onHand(0)).toBe(9); await ledgerOk();
    const again = await w.push([saleFor([{ v: 0, qty: 2 }], r.body.id).cmd]); expect(again.body.results[0].flags).toContain("online_order_not_open"); expect(await onHand(0)).toBe(7);
    const ghost = await w.push([saleFor([{ v: 1, qty: 1 }], randomUUID()).cmd]); expect(ghost.body.results[0].flags).toContain("online_order_unknown"); await ledgerOk();
    const c = await order([{ v: 1, qty: 1 }]); await h.http().post(`/shop/${w.orgId}/orders/${c.body.id}/cancel?t=${c.body.accessToken}`); expect((await w.push([saleFor([{ v: 1, qty: 1 }], c.body.id).cmd])).body.results[0].flags).toContain("online_order_not_open");
  });
});
