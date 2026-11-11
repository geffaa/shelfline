import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { LedgerService } from "../src/inventory/ledger.service";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let c: Awaited<ReturnType<typeof catalogWorld>>;
let purchaser: ReturnType<Awaited<ReturnType<typeof catalogWorld>>["as"]>, finance: typeof purchaser;
let sup: { id: string }; let vs: { id: string; sku: string }[];
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); c = await catalogWorld(h);
  await c.owner.post("/users", { email: "pat@kestrel.test", name: "Pat", password: "purchaser-password-1", assignments: [{ role: "purchaser", locationId: null }] });
  await c.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-123", assignments: [{ role: "finance", locationId: null }] });
  purchaser = c.as((await c.login("pat@kestrel.test", "purchaser-password-1")).body.token); finance = c.as((await c.login("fin@kestrel.test", "finance-password-123")).body.token);
  sup = (await purchaser.post("/suppliers", { name: "Tempra Australia", termsDays: 30, email: "orders@tempra.test" })).body;
  const p = (await c.hqApi.post("/products", { title: "Tempra Glide 4", taxClassId: c.gst.id, variants: [{ sku: "PG-A", basePriceMinor: 21995 }, { sku: "PG-B", basePriceMinor: 8900 }] })).body; vs = p.variants;
});
const po = async (lines = [{ variantId: vs[0]!.id, qty: 60, unitCostMinor: 5000 }], extra: object = {}) => {
  const r = await purchaser.post("/purchase-orders", { supplierId: sup.id, locationId: c.fitzroy.id, lines, ...extra }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string; number: string };
};
const sent = async (lines?: any) => { const p = await po(lines); expect((await purchaser.post(`/purchase-orders/${p.id}/send`)).status).toBe(200); return p; };
const detail = async (id: string) => (await purchaser.get(`/purchase-orders/${id}`)).body;
const receive = (id: string, lines: { poLineId: string; qty: number }[], extra: object = {}) => purchaser.post(`/purchase-orders/${id}/receive`, { idempotencyKey: randomUUID(), lines, ...extra });
const onHand = async (variantId: string, loc = c.fitzroy.id) => Number(((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${variantId} and location_id = ${loc}`)).rows[0] as any)?.on_hand ?? 0);
const avg = async (variantId: string, loc = c.fitzroy.id) => Number(((await h.db.execute(sql`select avg_cost_minor from shelfline.stock_balance where variant_id = ${variantId} and location_id = ${loc}`)).rows[0] as any)?.avg_cost_minor);
const appendOnly = async (q: Promise<unknown>) => { let err: any; try { await q; } catch (e) { err = e; } expect(String(err?.cause?.message ?? err?.message)).toMatch(/append-only/); };
const bill = (lines: object[], extra: object = {}) => finance.post("/bills", { supplierId: sup.id, number: `INV-${randomUUID().slice(0, 6)}`, billDate: "2026-10-01", lines, ...extra });

describe("suppliers", () => {
  it("are created, found, edited and archived; names are unique ignoring case; only purchasing roles may write", async () => {
    expect((await purchaser.post("/suppliers", { name: "TEMPRA AUSTRALIA" })).status).toBe(409);
    expect((await c.mgr.post("/suppliers", { name: "Nope" })).status).toBe(403); expect((await c.mgr.get("/suppliers")).status).toBe(403);
    expect((await purchaser.patch(`/suppliers/${sup.id}`, { termsDays: 14, phone: "03 9000 0000" })).body).toMatchObject({ termsDays: 14, phone: "03 9000 0000" });
    expect((await purchaser.get("/suppliers?q=tempra")).body).toHaveLength(1);
    await purchaser.patch(`/suppliers/${sup.id}`, { status: "archived" });
    expect((await purchaser.post("/purchase-orders", { supplierId: sup.id, locationId: c.fitzroy.id, lines: [{ variantId: vs[0]!.id, qty: 1, unitCostMinor: 100 }] })).status).toBe(400);
    expect((await purchaser.post("/suppliers", { name: "x", termsDays: 400 })).status).toBe(400);
  });
});

describe("purchase orders", () => {
  it("a part delivery of 40 of 60 adds 40 to stock and leaves the order partial with 20 open; the rest closes it; over-receiving is refused", async () => {
    const p = await sent(); const d0 = await detail(p.id); const l = d0.lines[0];
    expect(d0).toMatchObject({ status: "sent", supplier: "Tempra Australia", location: "Fitzroy" }); expect(p.number).toMatch(/^PO-\d{6}$/);
    const r1 = await receive(p.id, [{ poLineId: l.id, qty: 40 }]); expect(r1.status, JSON.stringify(r1.body)).toBe(200); expect(r1.body).toMatchObject({ replayed: false, status: "partial" });
    expect(await onHand(vs[0]!.id)).toBe(40); expect((await detail(p.id)).lines[0]).toMatchObject({ qtyReceived: 40, qtyOrdered: 60 });
    expect((await receive(p.id, [{ poLineId: l.id, qty: 21 }])).body).toMatchObject({ code: "over_receipt", open: 20 });
    expect((await receive(p.id, [{ poLineId: l.id, qty: 20 }])).body).toMatchObject({ status: "received" });
    expect(await onHand(vs[0]!.id)).toBe(60); expect((await detail(p.id)).status).toBe("received");
    expect((await receive(p.id, [{ poLineId: l.id, qty: 1 }])).body).toMatchObject({ code: "po_not_receivable" });
    expect((await detail(p.id)).receipts).toHaveLength(2); expect(await h.app.get(LedgerService).check(c.orgId)).toEqual([]);
  });
  it("a retried receipt (same key) adds stock once; a draft cannot be received; a received order cannot be cancelled; only a part-delivered one can be closed", async () => {
    const d = await po(); const dl = (await detail(d.id)).lines[0];
    expect((await receive(d.id, [{ poLineId: dl.id, qty: 1 }])).body).toMatchObject({ code: "po_not_receivable", status: "draft" });
    expect((await purchaser.post(`/purchase-orders/${d.id}/close`)).status).toBe(409);
    await purchaser.post(`/purchase-orders/${d.id}/send`); const key = randomUUID(); const body = { idempotencyKey: key, lines: [{ poLineId: dl.id, qty: 10 }] };
    const a = await purchaser.post(`/purchase-orders/${d.id}/receive`, body), b = await purchaser.post(`/purchase-orders/${d.id}/receive`, body);
    expect(a.body.replayed).toBe(false); expect(b.body).toMatchObject({ replayed: true, receiptId: a.body.receiptId }); expect(await onHand(vs[0]!.id)).toBe(10);
    expect((await purchaser.post(`/purchase-orders/${d.id}/cancel`)).body).toMatchObject({ code: "po_has_receipts" });
    expect((await purchaser.post(`/purchase-orders/${d.id}/close`)).body).toMatchObject({ status: "closed" }); expect(await onHand(vs[0]!.id)).toBe(10);
    const e = await sent(); expect((await purchaser.post(`/purchase-orders/${e.id}/cancel`)).body.status).toBe("cancelled");
  });
  it("a draft can be edited (lines replaced); a sent order cannot; duplicate variants and untracked stock are refused", async () => {
    const d = await po(); const up = await purchaser.patch(`/purchase-orders/${d.id}`, { note: "rush", lines: [{ variantId: vs[1]!.id, qty: 5, unitCostMinor: 2500 }] });
    expect(up.status).toBe(200); const det = await detail(d.id); expect(det.note).toBe("rush"); expect(det.lines).toHaveLength(1); expect(det.lines[0]).toMatchObject({ sku: "PG-B", qtyOrdered: 5 });
    await purchaser.post(`/purchase-orders/${d.id}/send`); expect((await purchaser.patch(`/purchase-orders/${d.id}`, { note: "late" })).body).toMatchObject({ code: "po_not_draft" });
    expect((await purchaser.post("/purchase-orders", { supplierId: sup.id, locationId: c.fitzroy.id, lines: [{ variantId: vs[0]!.id, qty: 1, unitCostMinor: 1 }, { variantId: vs[0]!.id, qty: 2, unitCostMinor: 1 }] })).status).toBe(400);
    expect((await purchaser.post("/purchase-orders", { supplierId: sup.id, locationId: c.fitzroy.id, lines: [] })).status).toBe(400);
  });
  it("lists orders with quantities and value, filtered by status and supplier", async () => {
    await sent([{ variantId: vs[0]!.id, qty: 60, unitCostMinor: 5000 }, { variantId: vs[1]!.id, qty: 10, unitCostMinor: 2000 }]); await po();
    const all = (await purchaser.get("/purchase-orders")).body; expect(all).toHaveLength(2);
    expect((await purchaser.get("/purchase-orders?status=sent")).body[0]).toMatchObject({ qtyOrdered: 70, qtyReceived: 0, valueMinor: 320000, supplier: "Tempra Australia", location: "Fitzroy" });
    expect((await purchaser.get(`/purchase-orders?supplierId=${randomUUID()}`)).body).toEqual([]);
  });
  it("a store manager can receive their own store's order but cannot see purchasing; a manager of another store cannot receive it", async () => {
    const p = await sent(); const l = (await detail(p.id)).lines[0];
    expect((await c.mgr.get("/purchase-orders")).status).toBe(403);
    expect((await c.mgr.post(`/purchase-orders/${p.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: l.id, qty: 5 }] })).status).toBe(200);
    const other = (await c.owner.post("/users", { email: "sy@kestrel.test", name: "Sy", password: "south-yarra-pass-1", assignments: [{ role: "store_manager", locationId: c.southYarra.id }] })).body;
    const sy = c.as((await c.login("sy@kestrel.test", "south-yarra-pass-1")).body.token); expect(other.id).toBeTruthy();
    expect((await sy.post(`/purchase-orders/${p.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: l.id, qty: 5 }] })).status).toBe(403);
    expect((await finance.post("/purchase-orders", { supplierId: sup.id, locationId: c.fitzroy.id, lines: [{ variantId: vs[0]!.id, qty: 1, unitCostMinor: 1 }] })).status).toBe(403);
  });
});

describe("variant picker", () => {
  it("finds stock-tracked active variants by title, SKU or barcode, needs two characters, and is for catalogue readers only", async () => {
    expect((await purchaser.get("/variants/search?q=g")).body).toEqual([]);
    expect((await purchaser.get("/variants/search?q=glide")).body.map((x: any) => x.sku)).toEqual(["PG-A", "PG-B"]);
    expect((await purchaser.get("/variants/search?q=pg-b")).body).toMatchObject([{ sku: "PG-B", title: "Tempra Glide 4", basePriceMinor: 8900 }]);
    expect((await c.mgr.get("/variants/search?q=glide")).status).toBe(200); expect((await c.as("bad").get("/variants/search?q=glide")).status).toBe(401);
  });
});

describe("landed cost", () => {
  it("freight is spread over the lines, raises the moving average, and the next sale takes that cost", async () => {
    const p = await sent([{ variantId: vs[0]!.id, qty: 40, unitCostMinor: 5000 }, { variantId: vs[1]!.id, qty: 10, unitCostMinor: 10000 }]); const ls = (await detail(p.id)).lines;
    const r = await receive(p.id, [{ poLineId: ls[0].id, qty: 40 }, { poLineId: ls[1].id, qty: 10 }], { freightMinor: 3001 });
    expect(r.body.landed.map((x: any) => [x.allocMinor, x.landedUnitCostMinor])).toEqual([[2001, 5050], [1000, 10100]]);
    expect(await avg(vs[0]!.id)).toBe(5050); expect(await avg(vs[1]!.id)).toBe(10100);
    const rl = (await h.db.execute(sql`select sum(landed_alloc_minor)::int as s from shelfline.receipt_line`)).rows[0] as any; expect(Number(rl.s)).toBe(3001);
    // a second delivery at another cost blends into the average, and a sale then costs the blend
    const p2 = await sent([{ variantId: vs[0]!.id, qty: 40, unitCostMinor: 6000 }]); const l2 = (await detail(p2.id)).lines[0];
    await receive(p2.id, [{ poLineId: l2.id, qty: 40 }], { freightMinor: 0 }); expect(await avg(vs[0]!.id)).toBe(5525);          // (40*5050 + 40*6000) / 80
    await h.app.get(LedgerService).append(c.orgId, c.manager.id, [{ variantId: vs[0]!.id, locationId: c.fitzroy.id, qtyDelta: -1, kind: "sale", sourceType: "sale", sourceId: randomUUID() }]);
    const [m] = (await h.db.execute(sql`select unit_cost_minor from shelfline.stock_movement where kind = 'sale' order by id desc limit 1`)).rows as any[]; expect(Number(m.unit_cost_minor)).toBe(5525);
  });
  it("receipts and their lines cannot be edited or deleted", async () => {
    const p = await sent(); await receive(p.id, [{ poLineId: (await detail(p.id)).lines[0].id, qty: 5 }]);
    await appendOnly(h.db.execute(sql`update shelfline.receipt set freight_minor = 1`)); await appendOnly(h.db.execute(sql`delete from shelfline.receipt_line`));
  });
});

describe("supplier bills", () => {
  it("a bill for 60 against 40 received is held and cannot be paid; when the other 20 arrive it is released and can be", async () => {
    const p = await sent(); const l = (await detail(p.id)).lines[0]; await receive(p.id, [{ poLineId: l.id, qty: 40 }]);
    const b = await bill([{ poLineId: l.id, variantId: vs[0]!.id, qty: 60, unitCostMinor: 5000 }], { poId: p.id }); expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body).toMatchObject({ status: "held", holdReasons: ["over_billed"], totalMinor: 300000 });
    const g = (await finance.get(`/bills/${b.body.id}`)).body; expect(g.lines[0].match).toMatchObject({ billedQty: 60, receivedQty: 40, qtyDiff: 20, status: "over_billed" });
    const pay = { amountMinor: 100000, paidOn: "2026-10-20", method: "bank_transfer", idempotencyKey: randomUUID() };
    expect((await finance.post(`/bills/${b.body.id}/payments`, pay)).body).toMatchObject({ code: "bill_held" });
    expect((await finance.post(`/bills/${b.body.id}/rematch`)).body).toEqual({ released: false });
    const r = await receive(p.id, [{ poLineId: l.id, qty: 20 }]); expect(r.body.billsReleased).toEqual([b.body.id]);
    const after = (await finance.get(`/bills/${b.body.id}`)).body; expect(after).toMatchObject({ status: "open", holdReasons: [] }); expect(after.lines[0].match).toMatchObject({ qtyDiff: 0, status: "ok" });
    expect((await finance.post(`/bills/${b.body.id}/payments`, pay)).body).toMatchObject({ status: "partially_paid", paidMinor: 100000 });
  });
  it("a price above the order is held until finance approves it with a reason; the reason stays on the bill and in the audit log", async () => {
    const p = await sent(); const l = (await detail(p.id)).lines[0]; await receive(p.id, [{ poLineId: l.id, qty: 60 }]);
    const b = (await bill([{ poLineId: l.id, variantId: vs[0]!.id, qty: 60, unitCostMinor: 5100 }], { poId: p.id })).body; expect(b).toMatchObject({ status: "held", holdReasons: ["price_variance"] });
    expect((await finance.get(`/bills/${b.id}`)).body.lines[0].match).toMatchObject({ costDiffMinor: 6000, status: "price_variance" });
    expect((await purchaser.post(`/bills/${b.id}/approve`, { note: "agreed by phone" })).status).toBe(403);
    expect((await finance.post(`/bills/${b.id}/approve`, { note: "x" })).status).toBe(400);
    expect((await finance.post(`/bills/${b.id}/approve`, { note: "Price rise agreed by phone with Tempra" })).body).toMatchObject({ status: "open", approvedNote: "Price rise agreed by phone with Tempra" });
    expect((await finance.post(`/bills/${b.id}/approve`, { note: "again please" })).status).toBe(409);
    const au = (await c.owner.get("/audit?action=bill.approve")).body[0]; expect(au).toMatchObject({ action: "bill.approve", subjectId: b.id, actorName: "Fin" }); expect(JSON.stringify(au.after)).toContain("Price rise agreed");
  });
  it("payments: partial then full, overpayment refused, a retry with the same key pays once, paid bills and bills with payments cannot be voided", async () => {
    const p = await sent(); const l = (await detail(p.id)).lines[0]; await receive(p.id, [{ poLineId: l.id, qty: 60 }]);
    const b = (await bill([{ poLineId: l.id, variantId: vs[0]!.id, qty: 60, unitCostMinor: 5000 }], { poId: p.id })).body; expect(b.status).toBe("open");
    const k = randomUUID(); const pay = (amountMinor: number, key = randomUUID()) => finance.post(`/bills/${b.id}/payments`, { amountMinor, paidOn: "2026-10-05", method: "bank_transfer", reference: "EFT 7731", idempotencyKey: key });
    expect((await pay(100000, k)).body).toMatchObject({ replayed: false, status: "partially_paid", paidMinor: 100000 }); expect((await pay(100000, k)).body).toMatchObject({ replayed: true, paidMinor: 100000 });
    expect((await pay(200001)).body).toMatchObject({ code: "overpayment", owedMinor: 200000 }); expect((await finance.post(`/bills/${b.id}/void`)).body).toMatchObject({ code: "bill_not_voidable" });
    expect((await pay(200000)).body).toMatchObject({ status: "paid", paidMinor: 300000 }); expect((await pay(1)).body).toMatchObject({ code: "bill_not_payable" });
    expect((await finance.get(`/bills/${b.id}`)).body.payments).toHaveLength(2);
    await appendOnly(h.db.execute(sql`update shelfline.bill_payment set amount_minor = 1`));
  });
  it("bill numbers are unique per supplier; a bill with no order lines (freight, services) is open at once; due date comes from the terms; two bills cannot both claim the same goods", async () => {
    const free = await bill([{ description: "Courier", qty: 1, unitCostMinor: 4500 }], { number: "C-1", billDate: "2026-10-01" }); expect(free.body).toMatchObject({ status: "open", dueOn: "2026-10-31", totalMinor: 4500 });
    expect((await bill([{ description: "Courier", qty: 1, unitCostMinor: 4500 }], { number: "c-1" })).body).toMatchObject({ code: "bill_number_taken" });
    expect((await bill([{ description: "x", qty: 1, unitCostMinor: 1 }], { dueOn: "2026-09-01" })).body).toMatchObject({ code: "due_before_bill_date" });
    const p = await sent(); const l = (await detail(p.id)).lines[0]; await receive(p.id, [{ poLineId: l.id, qty: 40 }]);
    const a = await bill([{ poLineId: l.id, qty: 40, unitCostMinor: 5000 }], { poId: p.id }); expect(a.body.status).toBe("open");
    const dup = await bill([{ poLineId: l.id, qty: 10, unitCostMinor: 5000 }], { poId: p.id }); expect(dup.body).toMatchObject({ status: "held", holdReasons: ["over_billed"] });   // 40 + 10 > 40 received
    expect((await finance.post(`/bills/${a.body.id}/void`)).body.status).toBe("void"); expect((await finance.post(`/bills/${dup.body.id}/rematch`)).body).toEqual({ released: true });   // the first claim is gone
    const other = (await c.owner.post("/suppliers", { name: "Other Co" })).body; const x = await finance.post("/bills", { supplierId: other.id, number: "Z", billDate: "2026-10-01", poId: p.id, lines: [{ qty: 1, unitCostMinor: 1 }] }); expect(x.body).toMatchObject({ code: "po_supplier_mismatch" });
  });
  it("aging puts what is owed into days-past-due buckets per supplier, and shows held amounts apart; payments reduce it", async () => {
    const free = (n: string, date: string, amt: number) => bill([{ description: "Goods", qty: 1, unitCostMinor: amt }], { number: n, billDate: date, dueOn: date });
    await free("A", "2026-11-30", 1000); await free("B", "2026-11-15", 2000); await free("C", "2026-10-20", 3000); await free("D", "2026-09-01", 4000); await free("E", "2026-07-01", 5000);
    const p = await sent(); const l = (await detail(p.id)).lines[0]; const held = (await bill([{ poLineId: l.id, qty: 5, unitCostMinor: 100 }], { number: "H", billDate: "2026-11-01", dueOn: "2026-11-01", poId: p.id })).body; expect(held.status).toBe("held");
    const ag = (await finance.get("/bills/aging?asOf=2026-11-30")).body; expect(ag.rows).toHaveLength(1);
    expect(ag.rows[0]).toMatchObject({ supplier: "Tempra Australia", current: 1000, d1_30: 2000 + 500, d31_60: 3000, d61_90: 4000, d90plus: 5000, total: 15500, held: 500 }); expect(ag.totals.total).toBe(15500);
    const bills = (await finance.get("/bills?status=open")).body; const c3 = bills.find((x: any) => x.number === "C");
    await finance.post(`/bills/${c3.id}/payments`, { amountMinor: 3000, paidOn: "2026-11-02", method: "card", idempotencyKey: randomUUID() });
    expect((await finance.get("/bills/aging?asOf=2026-11-30")).body.rows[0]).toMatchObject({ d31_60: 0, total: 12500 });
    expect((await finance.get("/bills?overdue=1&asOf=2026-11-30")).body.map((x: any) => x.number).sort()).toEqual(["B", "D", "E", "H"]);
    expect((await c.mgr.get("/bills/aging")).status).toBe(403);
  });
});
