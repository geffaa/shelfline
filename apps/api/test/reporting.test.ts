import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

type W = Awaited<ReturnType<typeof posWorld>>;
function saleOf(sessionId: string, lines: { variantId: string; qty: number; unitPriceMinor: number; discountMinor?: number }[], tender: "cash" | "card" = "cash", o: { receiptNo?: string; customerId?: string | null } = {}) {
  const priced = priceCart(lines.map((l) => ({ ...l, discountMinor: l.discountMinor ?? 0, tax: { rateBp: 1000, inclusive: true } })));
  return { saleId: randomUUID(), sessionId, receiptNo: o.receiptNo ?? `R-${randomUUID().slice(0, 6)}`, customerId: o.customerId ?? null, lines: lines.map((l) => ({ ...l, discountMinor: l.discountMinor ?? 0 })), payments: [{ tender, amountMinor: priced.payableMinor, ...(tender === "cash" ? { tenderedMinor: priced.payableMinor } : {}) }],
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: priced.discountMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null };
}
async function open(w: W, float = 30000) { const id = randomUUID(); await w.push([w.cmd("session.open", { sessionId: id, openingFloatMinor: float })]); return id; }
/** A day at Fitzroy: two cash sales, one card sale, one refund; returns the ids. */
async function busyDay(w: W) {
  const s = await open(w); const [A, B] = [w.v[0]!.id, w.v[1]!.id];
  const s1 = saleOf(s, [{ variantId: A, qty: 1, unitPriceMinor: 21995 }], "cash", { receiptNo: "FIT-2-000001" }), s2 = saleOf(s, [{ variantId: B, qty: 2, unitPriceMinor: 8900, discountMinor: 890 }], "card", { receiptNo: "FIT-2-000002" });
  await w.push([s1, s2].map((x) => w.cmd("sale.create", x)));
  const ln = s1.lines[0]!; const tax = priceCart([{ ...ln, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }]).taxMinor;
  const ra = refundAmount({ qty: 1, refundedQty: 0, totalMinor: 21995, refundedMinor: 0, taxMinor: tax, refundedTaxMinor: 0 }, 1);
  await w.push([w.cmd("refund.create", { refundId: randomUUID(), saleId: s1.saleId, sessionId: s, tender: "cash", reason: "faulty", lines: [{ saleLineNo: 0, qty: 1, ...ra, restock: true }], totalMinor: ra.amountMinor })]);
  return { s, s1, s2 };
}
const pos = (w: W) => ({ Authorization: `Bearer ${w.tok}` });

describe("overview (Today)", () => {
  it("totals, hourly series, open registers, exceptions and offline tills for the day", async () => {
    const w = await posWorld(h, { stock: 100 }); const { s } = await busyDay(w);
    await w.push([w.cmd("sale.create", saleOf(s, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 5000 }], "cash", { receiptNo: "FIT-2-000003" }))]);   // fine
    await w.push([w.cmd("sale.create", { ...saleOf(s, [{ variantId: w.v[2]!.id, qty: 1, unitPriceMinor: 3400 }], "card", { receiptNo: "FIT-2-000004" }), totals: { subtotalMinor: 3400, discountMinor: 0, taxMinor: 309, totalMinor: 3401, roundingMinor: 0, payableMinor: 3401 } })]);   // price mismatch
    const o = (await w.owner.get(`/overview?locationId=${w.fitzroy.id}`)).body;
    expect(o.totals).toMatchObject({ orders: 4, grossMinor: 21995 + 16910 + 5000 + 3401, discountMinor: 890, refundsMinor: 21995, refundsCount: 1, netMinor: 21995 + 16910 + 5000 + 3401 - 21995, items: 1 + 2 + 1 + 1 });
    expect(o.totals.avgBasketMinor).toBe(Math.round(o.totals.grossMinor / 4));
    expect(o.hours).toHaveLength(24); expect(o.hours.reduce((a: number, x: { netMinor: number }) => a + x.netMinor, 0)).toBe(o.totals.netMinor);
    expect(o.openSessions).toHaveLength(1); expect(o.openSessions[0]).toMatchObject({ location: "Fitzroy", cashier: expect.any(String), salesCount: 4 });
    expect(o.exceptions.map((e: { kind: string }) => e.kind)).toContain("price_mismatch");
    expect(o.offlineDevices).toEqual([]);                                                       // it synced a moment ago
    await h.db.execute(sql`update shelfline.device set last_seen_at = now() - interval '10 minutes'`);
    expect(((await w.owner.get(`/overview?locationId=${w.fitzroy.id}`)).body.offlineDevices as { name: string }[]).map((d) => d.name)).toContain("iPad FIT-2");   // silent for 10 minutes: offline
    expect((await w.owner.get("/overview/locations")).body.find((l: { name: string }) => l.name === "Fitzroy").devicesOffline).toBe(1);
  });
  it("yesterday's net is shown for comparison, and the lens limits every number", async () => {
    const w = await posWorld(h, { stock: 100 }); const { s1 } = await busyDay(w);
    await h.db.execute(sql`update shelfline.sale set local_date = local_date - 1 where id = ${s1.saleId}`);
    await h.db.execute(sql`update shelfline.refund set local_date = local_date - 1`);
    const o = (await w.owner.get(`/overview?locationId=${w.fitzroy.id}`)).body;
    expect(o.totals.yesterdayNetMinor).toBe(0); expect(o.totals.netMinor).toBe(16910);
    const sy = (await w.owner.get(`/overview?locationId=${w.southYarra.id}`)).body; expect(sy.totals).toMatchObject({ orders: 0, netMinor: 0 });
    const all = (await w.owner.get("/overview")).body; expect(all.totals.netMinor).toBe(16910);
  });
  it("a Fitzroy manager sees Fitzroy only, in the rail and in the numbers; South Yarra is 403", async () => {
    const w = await posWorld(h, { stock: 100 }); await busyDay(w);
    const rail = (await w.mgr.get("/overview/locations")).body; expect(rail.map((l: { name: string }) => l.name)).toEqual(["Fitzroy"]);
    expect(rail[0]).toMatchObject({ registersOpen: 1, netTodayMinor: 16910 });
    expect((await w.mgr.get(`/overview?locationId=${w.southYarra.id}`)).status).toBe(403);
    expect((await w.mgr.get("/overview")).body.totals.netMinor).toBe(16910);
    const ownerRail = (await w.owner.get("/overview/locations")).body; expect(ownerRail.map((l: { name: string }) => l.name).sort()).toEqual(["Fitzroy", "South Yarra"]);
    expect(ownerRail.find((l: { name: string }) => l.name === "South Yarra")).toMatchObject({ registersOpen: 0, netTodayMinor: 0 });
  });
  it("people without sale:read (a cashier signed in to the admin) get 403", async () => {
    const w = await posWorld(h);
    await w.owner.post("/users", { email: "cash@kestrel.test", name: "Cash", password: "cashier-password-123", assignments: [{ role: "cashier", locationId: w.fitzroy.id }] });
    const t = (await w.login("cash@kestrel.test", "cashier-password-123")).body.token; const a = w.as(t);
    for (const u of ["/overview", "/orders", "/exceptions", "/reports/sales?from=2026-01-01&to=2026-12-31", "/customers"]) expect((await a.get(u)).status, u).toBe(403);
  });
});

describe("orders", () => {
  it("lists newest first with filters, flags and pagination; detail has lines, payments, refunds and the exceptions of that sale", async () => {
    const w = await posWorld(h, { stock: 100 }); const { s, s1 } = await busyDay(w);
    await w.push([w.cmd("sale.create", { ...saleOf(s, [{ variantId: w.v[2]!.id, qty: 1, unitPriceMinor: 3400 }], "card", { receiptNo: "FIT-2-000003" }), totals: { subtotalMinor: 3400, discountMinor: 0, taxMinor: 309, totalMinor: 3401, roundingMinor: 0, payableMinor: 3401 } })]);
    await h.db.execute(sql`update shelfline.sale set effective_at = now() - ((10 - substring(receipt_no from '[0-9]+$')::int) || ' seconds')::interval`);   // distinct, ordered timestamps
    const all = (await w.owner.get(`/orders?locationId=${w.fitzroy.id}`)).body;
    expect(all.items.map((x: { receiptNo: string }) => x.receiptNo)).toEqual(["FIT-2-000003", "FIT-2-000002", "FIT-2-000001"]);
    expect(all.items[0]).toMatchObject({ location: "Fitzroy", register: "FIT-2", cashier: "Priya N.", tenders: ["card"], flags: ["price_mismatch", "payment_mismatch"], items: 1 });
    expect(all.items[2]).toMatchObject({ refundedMinor: 21995, status: "refunded", tenders: ["cash"] });
    expect((await w.owner.get("/orders?flag=price_mismatch")).body.items).toHaveLength(1);
    expect((await w.owner.get("/orders?q=000002")).body.items.map((x: { receiptNo: string }) => x.receiptNo)).toEqual(["FIT-2-000002"]);
    expect((await w.owner.get("/orders?status=refunded")).body.items).toHaveLength(1);
    expect((await w.owner.get("/orders?from=2999-01-01")).body.items).toHaveLength(0);
    const p1 = (await w.owner.get("/orders?limit=2")).body; expect(p1.items).toHaveLength(2); expect(p1.next).toBeTruthy();
    const p2 = (await w.owner.get(`/orders?limit=2&before=${p1.next}`)).body; expect(p2.items.map((x: { receiptNo: string }) => x.receiptNo)).toEqual(["FIT-2-000001"]); expect(p2.next).toBeNull();
    const d = (await w.owner.get(`/orders/${s1.saleId}`)).body;
    expect(d).toMatchObject({ receiptNo: "FIT-2-000001", status: "refunded", location: "Fitzroy", totals: { totalMinor: 21995, taxMinor: 1999 + 1 }, lines: [{ title: "Tempra Glide 3", qty: 1, refundedQty: 1, totalMinor: 21995 }], payments: [{ tender: "cash", amountMinor: 21995 }], refunds: [{ totalMinor: 21995, reason: "faulty", actor: "Priya N." }] });
    const flagged = all.items[0].id; expect((await w.owner.get(`/orders/${flagged}`)).body.exceptions.map((e: { kind: string }) => e.kind).sort()).toEqual(["payment_mismatch", "price_mismatch"]);
  });
  it("another location's orders are invisible and 403 on detail", async () => {
    const w = await posWorld(h, { stock: 100 }); const { s1 } = await busyDay(w);
    const other = (await w.owner.post("/users", { email: "sy@kestrel.test", name: "SY Mgr", password: "sy-manager-password-1", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] })).body; void other;
    const syTok = (await w.login("sy@kestrel.test", "sy-manager-password-1")).body.token; const sy = w.as(syTok);
    expect((await sy.get("/orders")).body.items).toEqual([]); expect((await sy.get(`/orders/${s1.saleId}`)).status).toBe(403); expect((await sy.get(`/orders?locationId=${w.fitzroy.id}`)).status).toBe(403);
    expect((await w.owner.get(`/orders/${randomUUID()}`)).status).toBe(404);
  });
});

describe("customers", () => {
  it("create, list with spend, detail with recent orders, edit with audit, unique email", async () => {
    const w = await posWorld(h, { stock: 100 });
    const c = (await w.mgr.post("/customers", { name: "Sam Okafor", email: "sam@example.test", phone: "0400 000 111", marketingConsent: { email: true } })).body;
    expect((await w.mgr.post("/customers", { name: "Samuel", email: "SAM@example.test" })).status).toBe(409);
    const s = await open(w); await w.push([w.cmd("sale.create", saleOf(s, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "card", { customerId: c.id }))]);
    const list = (await w.mgr.get("/customers?q=okafor")).body; expect(list).toMatchObject([{ name: "Sam Okafor", orders: 1, spentMinor: 21995 }]);
    const d = (await w.mgr.get(`/customers/${c.id}`)).body; expect(d).toMatchObject({ name: "Sam Okafor", orders: 1, spentMinor: 21995, recent: [{ totalMinor: 21995, location: "Fitzroy" }] });
    expect((await w.mgr.patch(`/customers/${c.id}`, { phone: "0411 222 333", marketingConsent: { email: false } })).status).toBe(200);
    const a = (await w.owner.get("/audit?action=customer.update")).body[0]; expect(a.before.phone).toBe("0400 000 111"); expect(a.after.phone).toBe("0411 222 333"); expect(a.actorName).toBe("Marcus T.");
    expect((await w.mgr.patch(`/customers/${c.id}`, {})).status).toBe(400);
  });
});

describe("sales report", () => {
  it("by day, location and product; refunds count on the day they were given; CSV export", async () => {
    const w = await posWorld(h, { stock: 100 }); const { s1 } = await busyDay(w);
    const today = (await w.owner.get(`/orders?locationId=${w.fitzroy.id}`)).body.items[0].localDate as string;
    const day = (await w.owner.get(`/reports/sales?from=${today}&to=${today}&groupBy=day`)).body;
    expect(day.rows).toHaveLength(1); expect(day.totals).toMatchObject({ orders: 2, grossMinor: 21995 + 16910, discountMinor: 890, refundsMinor: 21995, netMinor: 16910 });
    const loc = (await w.owner.get(`/reports/sales?from=${today}&to=${today}&groupBy=location`)).body; expect(loc.rows).toMatchObject([{ label: "Fitzroy", netMinor: 16910 }]);
    const prod = (await w.owner.get(`/reports/sales?from=${today}&to=${today}&groupBy=product`)).body; expect(prod.rows.map((r: { label: string }) => r.label)).toContain("Tempra Glide 3");
    expect(prod.totals.refundsMinor).toBe(21995);
    await h.db.execute(sql`update shelfline.refund set local_date = local_date + 1 where sale_id = ${s1.saleId}`);                      // refunded the next day
    const two = (await w.owner.get(`/reports/sales?from=${today}&to=2999-01-01&groupBy=day`)).body; expect(two.rows).toHaveLength(2); expect(two.rows[0].netMinor).toBe(21995 + 16910); expect(two.rows[1]).toMatchObject({ refundsMinor: 21995, netMinor: -21995, orders: 0 });
    const csv = await w.owner.get(`/reports/sales?from=${today}&to=2999-01-01&groupBy=location&format=csv`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/); expect(csv.text.split("\r\n")[0]).toBe("label,orders,items,gross,discounts,refunds,net,gst_included"); expect(csv.text).toContain("Fitzroy,2,3,389.05,8.90,219.95,169.10");
    expect((await w.owner.get("/reports/sales?from=bad&to=2026-01-01")).status).toBe(400);
    expect((await w.mgr.get(`/reports/sales?from=${today}&to=${today}&locationId=${w.southYarra.id}`)).status).toBe(403);
  });
});

describe("exceptions and audit", () => {
  it("managers see their store's open exceptions, and can resolve them; others cannot; resolution is audited", async () => {
    const w = await posWorld(h, { stock: 1 }); const s = await open(w);
    await w.push([w.cmd("sale.create", saleOf(s, [{ variantId: w.v[0]!.id, qty: 3, unitPriceMinor: 1000 }]))]);
    const list = (await w.mgr.get("/exceptions")).body; expect(list).toMatchObject([{ kind: "negative_stock", location: "Fitzroy", device: "iPad FIT-2", status: "open" }]); expect(list[0].receiptNo).toBeTruthy();
    expect((await w.owner.get("/exceptions?kind=price_mismatch")).body).toEqual([]);
    await w.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-123", assignments: [{ role: "finance", locationId: null }] });
    const fin = w.as((await w.login("fin@kestrel.test", "finance-password-123")).body.token);
    expect((await fin.get("/exceptions")).status).toBe(200); expect((await fin.post(`/exceptions/${list[0].id}/resolve`)).status).toBe(403);      // finance may look, not resolve
    expect((await w.mgr.post(`/exceptions/${list[0].id}/resolve`)).status).toBe(204);
    expect((await w.mgr.get("/exceptions")).body).toEqual([]); expect((await w.mgr.get("/exceptions?status=resolved")).body).toHaveLength(1);
    expect((await w.owner.get("/audit?action=sync.exception_resolved")).body[0].actorName).toBe("Marcus T.");
  });
  it("audit can be filtered by actor, subject and date, and carries the actor's name", async () => {
    const w = await posWorld(h);
    await w.mgr.post("/customers", { name: "A. Customer" });
    const byActor = (await w.owner.get(`/audit?actorId=${w.manager.id}`)).body; expect(byActor.every((r: { actorId: string }) => r.actorId === w.manager.id)).toBe(true); expect(byActor[0].actorName).toBe("Marcus T.");
    expect((await w.owner.get("/audit?subjectType=customer")).body).toHaveLength(1);
    expect((await w.owner.get("/audit?from=2999-01-01")).body).toEqual([]); expect((await w.owner.get("/audit?to=2000-01-01")).body).toEqual([]);
    const user = (await w.owner.get("/audit?action=user.create")).body[0]; expect(user.actorName).toBeTruthy();
  });
});

describe("live stream (SSE)", () => {
  async function listen(token: string, base: string) {
    const ctrl = new AbortController(); const res = await fetch(`${base}/stream`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctrl.signal });
    expect(res.status).toBe(200); const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ""; const events: { type: string; data: any }[] = [];
    (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const type = /^event: (.*)$/m.exec(blk)?.[1] ?? "message"; const data = /^data: (.*)$/m.exec(blk)?.[1]; events.push({ type, data: data ? JSON.parse(data) : null }); } } } catch { /* aborted */ } })();
    return { events, stop: () => ctrl.abort() };
  }
  it("a sale made on a till reaches a connected admin within two seconds; a manager of another store hears nothing", async () => {
    const w = await posWorld(h, { stock: 100 }); if (!h.app.getHttpServer().listening) await h.app.listen(0, "127.0.0.1"); const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
    const sy = (await w.owner.post("/users", { email: "sy@kestrel.test", name: "SY Mgr", password: "sy-manager-password-1", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] })).body; void sy;
    const syTok = (await w.login("sy@kestrel.test", "sy-manager-password-1")).body.token;
    const mine = await listen(w.mgrTok, base), theirs = await listen(syTok, base), owner = await listen(w.ownerTok, base);
    await new Promise((r) => setTimeout(r, 300));
    const s = await open(w); const t0 = Date.now();
    await w.push([w.cmd("sale.create", saleOf(s, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }]))]);
    await expect.poll(() => mine.events.some((e) => e.type === "change" && e.data.kind === "sale"), { timeout: 2000, interval: 50 }).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect.poll(() => owner.events.some((e) => e.data?.kind === "sale")).toBe(true);
    expect(theirs.events.filter((e) => e.type === "change")).toEqual([]);
    const sale = mine.events.find((e) => e.data?.kind === "sale")!; expect(sale.data).toMatchObject({ locationId: w.fitzroy.id }); expect(Object.keys(sale.data).sort()).toEqual(["id", "kind", "locationId"]);   // ids only
    mine.stop(); theirs.stop(); owner.stop();
  });
  it("needs a token and the sale:read permission", async () => {
    const w = await posWorld(h); if (!h.app.getHttpServer().listening) await h.app.listen(0, "127.0.0.1"); const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");
    expect((await fetch(`${base}/stream`)).status).toBe(401);
    await w.owner.post("/users", { email: "cash@kestrel.test", name: "Cash", password: "cashier-password-123", assignments: [{ role: "cashier", locationId: w.fitzroy.id }] });
    const t = (await w.login("cash@kestrel.test", "cashier-password-123")).body.token; expect((await fetch(`${base}/stream`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(403);
  });
});
void pos;
