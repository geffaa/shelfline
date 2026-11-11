import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { hmacOf } from "../src/channels/channels.service";
import { LedgerService } from "../src/inventory/ledger.service";
import { posWorld, reset, startApp, type Harness } from "./helpers";

/** A stand-in for the part of Shopify's Admin API the channel uses, holding its own idea of stock. */
class FakeShopify {
  token = "shpat_goodtoken"; levels = new Map<string, number>(); products: { id: number; title: string; variants: { id: number; sku: string | null; inventory_item_id: number; title: string }[] }[] = [];
  calls: string[] = []; setBodies: { inventory_item_id: number; available: number }[] = []; throttleOnce = false; failItem: number | null = null; server!: http.Server;
  async start() {
    this.server = http.createServer((req, res) => {
      this.calls.push(`${req.method} ${req.url}`); const url = new URL(req.url!, "http://x"); let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (o: unknown, status = 200, h: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
        if (req.headers["x-shopify-access-token"] !== this.token) return json({ errors: "Unauthorized" }, 401);
        if (url.pathname.endsWith("/shop.json")) return json({ shop: { name: "Kestrel Run (test shop)", myshopify_domain: "kestrel-test.myshopify.com" } });
        if (url.pathname.endsWith("/products.json")) { const page = Number(url.searchParams.get("page") ?? "1"); const per = 2; const slice = this.products.slice((page - 1) * per, page * per); const more = page * per < this.products.length; return json({ products: slice }, 200, more ? { link: `<http://127.0.0.1:19480${url.pathname}?limit=250&page=${page + 1}>; rel="next"` } : {}); }
        if (url.pathname.endsWith("/inventory_levels/set.json")) { const b = JSON.parse(body) as { inventory_item_id: number; available: number }; if (this.throttleOnce) { this.throttleOnce = false; return json({ errors: "Throttled" }, 429, { "retry-after": "0" }); } if (this.failItem === b.inventory_item_id) return json({ errors: "boom" }, 500); this.setBodies.push(b); this.levels.set(String(b.inventory_item_id), b.available); return json({ inventory_level: { available: b.available } }); }
        if (url.pathname.endsWith("/inventory_levels.json")) { const ids = (url.searchParams.get("inventory_item_ids") ?? "").split(",").filter(Boolean); return json({ inventory_levels: ids.filter((i) => this.levels.has(i)).map((i) => ({ inventory_item_id: Number(i), available: this.levels.get(i)! })) }); }
        json({ errors: "not found" }, 404);
      });
    });
    await new Promise<void>((ok) => this.server.listen(19480, "127.0.0.1", ok));
  }
  stop() { this.server.close(); }
}

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; const shopify = new FakeShopify();
beforeAll(async () => { await shopify.start(); h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); shopify.stop(); });
const SECRET = "whsec_test_secret_123";
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.channel_webhook, shelfline.channel_order, shelfline.channel_listing, shelfline.channel_connection cascade`); w = await posWorld(h, { stock: 7 });
  shopify.levels.clear(); shopify.calls = []; shopify.setBodies = []; shopify.throttleOnce = false; shopify.failItem = null; shopify.token = "shpat_goodtoken";
  shopify.products = [
    { id: 1, title: "Tempra Glide 3", variants: [{ id: 101, sku: "tg3-a", inventory_item_id: 9001, title: "10.5" }, { id: 102, sku: "TG3-B", inventory_item_id: 9002, title: "11" }] },
    { id: 2, title: "Crew socks", variants: [{ id: 103, sku: " TG3-C ", inventory_item_id: 9003, title: "L" }] },
    { id: 3, title: "Poster", variants: [{ id: 104, sku: "NOPE-1", inventory_item_id: 9004, title: "A2" }, { id: 105, sku: null, inventory_item_id: 9005, title: "A1" }] },
  ];
});
const connect = async (o: object = {}) => { const r = await w.owner.post("/channels", { name: "Kestrel online", shopDomain: "kestrel-test.myshopify.com", accessToken: "shpat_goodtoken", webhookSecret: SECRET, locationId: w.fitzroy.id, shopifyLocationId: "55001", ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string; webhookPath: string }; };
const mapped = async () => { const c = await connect(); const r = await w.owner.post(`/channels/${c.id}/import`); expect(r.status).toBe(200); return c; };
const onHand = async (v: number) => Number((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${w.v[v]!.id} and location_id = ${w.fitzroy.id}`)).rows[0]!.on_hand);
const order = (id = 7001, lines: { variant_id: number; sku?: string; quantity: number; title?: string }[] = [{ variant_id: 101, sku: "tg3-a", quantity: 2, title: "Tempra Glide 3" }], extra: object = {}) => JSON.stringify({ id, name: `#${id}`, currency: "AUD", total_price: "439.90", email: "buyer@example.com", line_items: lines, ...extra });
const send = (c: { id: string }, topic: string, body: string, o: { id?: string; secret?: string; hmac?: string } = {}) => h.http().post(`/channels/shopify/webhooks/${c.id}`).set("content-type", "application/json").set("x-shopify-topic", topic).set("x-shopify-webhook-id", o.id ?? randomUUID()).set("x-shopify-hmac-sha256", o.hmac ?? hmacOf(o.secret ?? SECRET, body)).send(body);
const ledgerOk = async () => expect(await h.app.get(LedgerService).check(w.orgId)).toEqual([]);

describe("connecting a shop", () => {
  it("checks the address, the token and the store, keeps secrets encrypted and never returns them", async () => {
    for (const bad of ["kestrel.example.com", "https://kestrel-test.myshopify.com", "kestrel-test.myshopify.com.evil.io", "-x.myshopify.com"]) expect([bad, (await w.owner.post("/channels", { name: "x", shopDomain: bad, accessToken: "shpat_goodtoken", webhookSecret: SECRET, locationId: w.fitzroy.id, shopifyLocationId: "55001" })).status]).toEqual([bad, 400]);
    expect((await w.owner.post("/channels", { name: "x", shopDomain: "kestrel-test.myshopify.com", accessToken: "shpat_wrongtoken", webhookSecret: SECRET, locationId: w.fitzroy.id, shopifyLocationId: "55001" })).body).toMatchObject({ code: "shopify_token_refused" });
    expect((await w.owner.post("/channels", { name: "x", shopDomain: "kestrel-test.myshopify.com", accessToken: "shpat_goodtoken", webhookSecret: SECRET, locationId: randomUUID(), shopifyLocationId: "55001" })).status).toBe(404);
    const c = await connect(); expect(c.webhookPath).toBe(`/channels/shopify/webhooks/${c.id}`); expect(JSON.stringify(c)).not.toMatch(/shpat|whsec|Enc/);
    const [row] = (await h.db.execute(sql`select access_token_enc, webhook_secret_enc from shelfline.channel_connection`)).rows as { access_token_enc: string; webhook_secret_enc: string }[]; expect(row!.access_token_enc).not.toContain("shpat"); expect(row!.webhook_secret_enc).not.toContain("whsec");
    expect((await w.owner.post("/channels", { name: "again", shopDomain: "kestrel-test.myshopify.com", accessToken: "shpat_goodtoken", webhookSecret: SECRET, locationId: w.fitzroy.id, shopifyLocationId: "55001" })).status).toBe(409);
    expect(JSON.stringify((await w.owner.get("/channels")).body)).not.toMatch(/shpat|whsec/); expect((await w.owner.get("/channels")).body[0]).toMatchObject({ name: "Kestrel online", hasToken: true, location: "Fitzroy", listings: 0 });
    expect((await w.mgr.get("/channels")).status).toBe(403); expect((await w.mgr.post("/channels", {})).status).toBe(403); expect((await w.owner.get("/audit?action=channel.connect")).body).toHaveLength(1);
  });
  it("maps Shopify variants to ours by SKU across pages, ignoring case and spaces, reports what did not match, and does nothing the second time", async () => {
    const c = await connect(); const a = (await w.owner.post(`/channels/${c.id}/import`)).body; expect(a).toMatchObject({ shopifyVariants: 5, added: 3, alreadyMapped: 0 }); expect(a.unmatched.map((u: { sku: string }) => u.sku).sort()).toEqual(["", "NOPE-1"]);
    expect(shopify.calls.filter((x) => x.includes("products.json"))).toHaveLength(2);                         // two pages followed
    expect((await w.owner.post(`/channels/${c.id}/import`)).body).toMatchObject({ added: 0, alreadyMapped: 3 }); const ls = (await w.owner.get(`/channels/${c.id}/listings`)).body; expect(ls.map((l: { sku: string }) => l.sku)).toEqual(["TG3-A", "TG3-B", "TG3-C"]);
  });
});

describe("pushing stock", () => {
  it("sends the quantity we hold, as an absolute number, only where it changed", async () => {
    const c = await mapped(); expect((await w.owner.post(`/channels/${c.id}/push`)).body).toEqual({ pushed: 3, skipped: 0, failed: 0 }); expect(shopify.levels.get("9001")).toBe(7); expect(shopify.setBodies.every((b) => b.available === 7)).toBe(true);
    expect((await w.owner.post(`/channels/${c.id}/push`)).body).toEqual({ pushed: 0, skipped: 3, failed: 0 }); await w.hqApi.post("/inventory/adjust", { locationId: w.fitzroy.id, variantId: w.v[1]!.id, qtyDelta: -4, reason: "damaged", idempotencyKey: randomUUID() });
    expect((await w.owner.post(`/channels/${c.id}/push`)).body).toEqual({ pushed: 1, skipped: 2, failed: 0 }); expect(shopify.levels.get("9002")).toBe(3);
  });
  it("never pushes a negative number, survives a throttle, and records which listing failed without stopping the rest", async () => {
    const c = await mapped(); await h.db.execute(sql`update shelfline.stock_balance set on_hand = -3 where variant_id = ${w.v[0]!.id} and location_id = ${w.fitzroy.id}`); shopify.throttleOnce = true;
    expect((await w.owner.post(`/channels/${c.id}/push`)).body).toEqual({ pushed: 3, skipped: 0, failed: 0 }); expect(shopify.levels.get("9001")).toBe(0);
    await h.db.execute(sql`update shelfline.channel_listing set last_pushed_qty = null`); shopify.failItem = 9002; const r = (await w.owner.post(`/channels/${c.id}/push`)).body; expect(r).toEqual({ pushed: 2, skipped: 0, failed: 1 }); expect((await w.owner.get("/channels")).body[0].lastError).toContain("shopify 500");
  });
  it("reconciliation finds what drifted in Shopify and puts it right, so Shopify ends equal to the ledger", async () => {
    const c = await mapped(); await w.owner.post(`/channels/${c.id}/push`); shopify.levels.set("9001", 99); shopify.levels.delete("9003");               // someone edited one in Shopify; one never made it
    const r = (await w.owner.post(`/channels/${c.id}/reconcile`)).body; expect(r).toMatchObject({ checked: 3, fixed: 2 }); expect(r.drift.map((d: { shopify: number | null }) => d.shopify).sort()).toEqual([99, null].sort());
    for (const id of ["9001", "9002", "9003"]) expect(shopify.levels.get(id)).toBe(7); expect((await w.owner.post(`/channels/${c.id}/reconcile`)).body).toMatchObject({ checked: 3, fixed: 0, drift: [] }); expect((await w.owner.get("/audit?action=channel.reconcile")).body).toHaveLength(2);
  });
});

describe("orders arriving by webhook", () => {
  it("the same order three times is one order: the same delivery, or three deliveries of it", async () => {
    const c = await mapped(); await w.owner.post(`/channels/${c.id}/push`); const body = order(7001); const same = randomUUID();
    const a = await send(c, "orders/create", body, { id: same }); expect(a.body).toMatchObject({ status: "imported", unmapped: 0 }); expect((await send(c, "orders/create", body, { id: same })).body).toEqual({ status: "duplicate" }); expect((await send(c, "orders/create", body, { id: same })).body).toEqual({ status: "duplicate" });
    expect((await send(c, "orders/create", body)).body).toEqual({ status: "duplicate_order" }); expect((await send(c, "orders/paid", body)).body).toEqual({ status: "duplicate_order" });
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.channel_order`)).rows[0]!.n).toBe(1); expect(await onHand(0)).toBe(5); await ledgerOk();                  // 7 less the 2 ordered, once
    expect((await h.db.execute(sql`select kind, qty_delta from shelfline.stock_movement where source_type = 'shopify_order'`)).rows).toEqual([{ kind: "sale", qty_delta: -2 }]);
    expect(shopify.levels.get("9001")).toBe(5);                                                                                                                                       // and Shopify was told the new number
    expect((await w.owner.get(`/channels/${c.id}/orders`)).body[0]).toMatchObject({ name: "#7001", status: "imported", totalMinor: 43990, customerEmail: "buyer@example.com", unmapped: 0 });
  });
  it("refuses a delivery with a wrong, missing or altered signature, a wrong secret, or another shop's address", async () => {
    const c = await mapped(); const body = order(7002);
    expect((await send(c, "orders/create", body, { secret: "whsec_other" })).status).toBe(401); expect((await send(c, "orders/create", body, { hmac: "" })).status).toBe(401); expect((await send(c, "orders/create", body, { hmac: hmacOf(SECRET, body.replace("2", "3")) })).status).toBe(401);
    expect((await h.http().post(`/channels/shopify/webhooks/${c.id}`).set("content-type", "application/json").set("x-shopify-topic", "orders/create").send(body)).status).toBe(401); expect((await send({ id: randomUUID() }, "orders/create", body)).status).toBe(401);
    expect(await onHand(0)).toBe(7); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.channel_webhook`)).rows[0]!.n).toBe(0);
    const tampered = await h.http().post(`/channels/shopify/webhooks/${c.id}`).set("content-type", "application/json").set("x-shopify-topic", "orders/create").set("x-shopify-hmac-sha256", hmacOf(SECRET, body)).send(body.replace('"quantity":2', '"quantity":1')); expect(tampered.status).toBe(401);
  });
  it("records lines it cannot match and still takes the ones it can; unknown topics are acknowledged and ignored; a paused channel records nothing", async () => {
    const c = await mapped(); const r = await send(c, "orders/create", order(7003, [{ variant_id: 101, sku: "tg3-a", quantity: 1 }, { variant_id: 999, sku: "ghost", quantity: 4, title: "Mystery" }])); expect(r.body).toMatchObject({ status: "imported", unmapped: 1 }); expect(await onHand(0)).toBe(6);
    expect((await w.owner.get(`/channels/${c.id}/orders`)).body[0]).toMatchObject({ unmapped: 1 }); expect((await w.owner.get("/channels")).body[0]).toMatchObject({ orders: 1, unmappedLines: 1 });
    expect((await send(c, "customers/update", "{}")).body).toMatchObject({ status: "ignored" }); expect((await send(c, "orders/create", "not json")).status).toBe(400);
    expect((await w.owner.patch(`/channels/${c.id}`, { status: "paused" })).status).toBe(200); expect((await send(c, "orders/create", order(7004))).body).toEqual({ status: "paused" }); expect(await onHand(0)).toBe(6); expect((await w.owner.post(`/channels/${c.id}/push`)).body).toEqual({ pushed: 0, skipped: 0, failed: 0 });
  });
  it("a cancelled order puts the stock back once, however often it is cancelled", async () => {
    const c = await mapped(); await send(c, "orders/create", order(7005, [{ variant_id: 102, sku: "TG3-B", quantity: 3 }])); expect(await onHand(1)).toBe(4);
    expect((await send(c, "orders/cancelled", JSON.stringify({ id: 7005 }))).body).toMatchObject({ status: "cancelled" }); expect(await onHand(1)).toBe(7); expect((await send(c, "orders/cancelled", JSON.stringify({ id: 7005 }))).body).toEqual({ status: "already_cancelled" }); expect(await onHand(1)).toBe(7);
    expect((await send(c, "orders/cancelled", JSON.stringify({ id: 424242 }))).body).toEqual({ status: "unknown_order" }); expect(shopify.levels.get("9002")).toBe(7); await ledgerOk();
    expect((await send(c, "orders/create", order(7005, [{ variant_id: 102, sku: "TG3-B", quantity: 3 }]))).body).toEqual({ status: "duplicate_order" }); expect(await onHand(1)).toBe(7);          // a cancelled order does not come back to life
  });
  it("two orders for the last stock both import; stock goes below zero and is flagged, never silently lost", async () => {
    const c = await mapped(); await send(c, "orders/create", order(7006, [{ variant_id: 101, sku: "tg3-a", quantity: 5 }])); await send(c, "orders/create", order(7007, [{ variant_id: 101, sku: "tg3-a", quantity: 5 }]));
    expect(await onHand(0)).toBe(-3); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.stock_movement where source_type = 'shopify_order' and flags @> array['negative_stock']`)).rows[0]!.n).toBe(1); expect(shopify.levels.get("9001")).toBe(0); await ledgerOk();
  });
  it("imported orders and delivery records cannot be changed or deleted, and disconnecting removes the secrets and stops everything", async () => {
    const c = await mapped(); await send(c, "orders/create", order(7008)); await expect(h.db.execute(sql`update shelfline.channel_order set total_minor = 1`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.channel_order`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.channel_webhook`)).rejects.toThrow();
    expect((await w.owner.patch(`/channels/${c.id}`, { status: "disconnected" })).body).toMatchObject({ status: "disconnected", hasToken: false }); expect((await send(c, "orders/create", order(7009))).status).toBe(401); expect((await w.owner.post(`/channels/${c.id}/push`)).status).toBe(200);
    expect((await w.owner.post(`/channels/${c.id}/import`)).status).toBe(409); expect((await h.db.execute(sql`select access_token_enc, webhook_secret_enc from shelfline.channel_connection`)).rows[0]).toEqual({ access_token_enc: null, webhook_secret_enc: null });
  });
});
