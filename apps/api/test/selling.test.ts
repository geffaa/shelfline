import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

type W = Awaited<ReturnType<typeof posWorld>>;
interface Line { variantId: string; qty: number; unitPriceMinor: number; discountMinor?: number; approvalToken?: string; discountReason?: string }

/** Builds a sale payload exactly as the till does: price with the shared code, then attach totals. */
function saleOf(w: W, sessionId: string, lines: Line[], o: { payments?: { tender: "cash" | "card" | "other"; amountMinor?: number; tenderedMinor?: number }[]; rate?: number; step?: number | null; receiptNo?: string; customerId?: string | null; saleId?: string; tamper?: number } = {}) {
  const priced = priceCart(lines.map((l) => ({ unitPriceMinor: l.unitPriceMinor, qty: l.qty, discountMinor: l.discountMinor ?? 0, tax: { rateBp: o.rate ?? 1000, inclusive: true } })), { cashRoundingStep: o.step ?? null });
  const payments = (o.payments ?? [{ tender: "card" as const }]).map((x, i, a) => ({ ...x, amountMinor: x.amountMinor ?? (a.length === 1 ? priced.payableMinor + (o.tamper ?? 0) : 0) }));
  return {
    saleId: o.saleId ?? randomUUID(), sessionId, receiptNo: o.receiptNo ?? "FIT-2-000001", customerId: o.customerId ?? null,
    lines: lines.map((l) => ({ discountMinor: 0, ...l })), payments,
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: priced.discountMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor + (o.tamper ?? 0), roundingMinor: priced.cashRoundingMinor, payableMinor: priced.payableMinor + (o.tamper ?? 0) },
    cashRoundingStep: o.step ?? null,
  };
}
async function open(w: W, sessionId = randomUUID(), float = 30000) { const r = await w.push([w.cmd("session.open", { sessionId, openingFloatMinor: float })]); expect(r.body.results[0].status).toBe("accepted"); return sessionId; }
const sampleLines = (w: W): Line[] => [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }, { variantId: w.v[1]!.id, qty: 1, unitPriceMinor: 8900, discountMinor: 890, discountReason: "friends and family" }, { variantId: w.v[2]!.id, qty: 2, unitPriceMinor: 3400 }];
const onHand = async (vid: string, loc: string) => Number((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${vid} and location_id = ${loc}`)).rows[0]?.on_hand);

describe("session.open", () => {
  it("opens a session; opening another at the same register force-closes the first and raises an exception", async () => {
    const w = await posWorld(h); const s1 = await open(w); const s2 = randomUUID();
    const r = await w.push([w.cmd("session.open", { sessionId: s2, openingFloatMinor: 25000 })]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["session_force_closed"] });
    const rows = (await h.db.execute(sql`select id, status, flags from shelfline.register_session order by opened_at`)).rows as { id: string; status: string; flags: string[] }[];
    expect(rows.map((x) => [x.id, x.status])).toEqual([[s1, "force_closed"], [s2, "open"]]); expect(rows[0]!.flags).toEqual(["needs_review"]);
    expect((await w.owner.get("/sync/exceptions")).body.map((e: { kind: string }) => e.kind)).toContain("session_force_closed");
  });
  it("re-sending the same open is idempotent", async () => {
    const w = await posWorld(h); const id = randomUUID(); const c = w.cmd("session.open", { sessionId: id, openingFloatMinor: 1000 });
    await w.push([c]); expect((await w.push([c])).body.results[0].status).toBe("duplicate");
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.register_session`)).rows[0]).toEqual({ n: 1 });
  });
});

describe("sale.create", () => {
  it("records the sample cart exactly: totals, per-line tax that sums to the tax, payments, change, stock, receipt; no flags", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const sale = saleOf(w, sid, sampleLines(w), { payments: [{ tender: "cash", amountMinor: 10000, tenderedMinor: 10000 }, { tender: "card", amountMinor: 26805 }] });
    expect(sale.totals).toMatchObject({ totalMinor: 36805, taxMinor: 3346 });
    const r = await w.push([w.cmd("sale.create", sale)]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", result: { receiptNo: "FIT-2-000001", totalMinor: 36805 } });
    const [row] = (await h.db.execute(sql`select * from shelfline.sale`)).rows as Record<string, unknown>[];
    expect(row).toMatchObject({ total_minor: 36805, tax_minor: 3346, discount_minor: 890, subtotal_minor: 37695, tendered_minor: 36805, change_minor: 0, flags: [], local_date: expect.anything() });
    const lines = (await h.db.execute(sql`select line_no, qty, total_minor, tax_minor, unit_cost_minor, attributed_to from shelfline.sale_line order by line_no`)).rows as { total_minor: number; tax_minor: number; unit_cost_minor: number; attributed_to: string }[];
    expect(lines.map((l) => l.total_minor)).toEqual([21995, 8010, 6800]); expect(lines.reduce((a, l) => a + l.tax_minor, 0)).toBe(3346);
    expect(lines.every((l) => l.unit_cost_minor === 5000 && l.attributed_to === w.cashier.id)).toBe(true);
    expect((await h.db.execute(sql`select tender, amount_minor from shelfline.payment order by id`)).rows).toEqual([{ tender: "cash", amount_minor: 10000 }, { tender: "card", amount_minor: 26805 }]);
    expect(await onHand(w.v[0]!.id, w.fitzroy.id)).toBe(9); expect(await onHand(w.v[2]!.id, w.fitzroy.id)).toBe(8);
    expect((await w.owner.get("/sync/exceptions")).body).toEqual([]);
  });
  it("cash with change: change is stored; cash rounding to 5c is accepted when the till and server agree", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const lines: Line[] = [{ variantId: w.v[2]!.id, qty: 1, unitPriceMinor: 3403 }];       // A$34.03 -> payable 34.05 with 5c rounding
    const sale = saleOf(w, sid, lines, { step: 5, payments: [{ tender: "cash", amountMinor: 3405, tenderedMinor: 5000 }] });
    expect(sale.totals).toMatchObject({ totalMinor: 3403, roundingMinor: 2, payableMinor: 3405 });
    expect((await w.push([w.cmd("sale.create", sale)])).body.results[0].status).toBe("accepted");
    expect((await h.db.execute(sql`select change_minor, tendered_minor, rounding_minor from shelfline.sale`)).rows[0]).toEqual({ change_minor: 1595, tendered_minor: 5000, rounding_minor: 2 });
  });
  it("replaying the same sale has no second effect", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const c = w.cmd("sale.create", saleOf(w, sid, sampleLines(w)));
    await w.push([c]); const again = await w.push([c]);
    expect(again.body.results[0].status).toBe("duplicate");
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sale`)).rows[0]).toEqual({ n: 1 });
    expect(await onHand(w.v[0]!.id, w.fitzroy.id)).toBe(9);
  });
  it("a till total that disagrees with the server is kept (the customer paid it) and flagged with both sets of numbers", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, sampleLines(w), { tamper: 1 }))]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["price_mismatch"] });
    expect((await h.db.execute(sql`select total_minor from shelfline.sale`)).rows[0]).toEqual({ total_minor: 36806 });
    const ex = (await w.owner.get("/sync/exceptions")).body.find((e: { kind: string }) => e.kind === "price_mismatch");
    expect(ex.detail.client.totalMinor).toBe(36806); expect(ex.detail.server.totalMinor).toBe(36805); expect(ex.refType).toBe("sale");
  });
  it("selling more than the shelf has is accepted: stock goes negative, flagged", async () => {
    const w = await posWorld(h, { stock: 1 }); const sid = await open(w);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, [{ variantId: w.v[0]!.id, qty: 3, unitPriceMinor: 21995 }]))]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["negative_stock"] });
    expect(await onHand(w.v[0]!.id, w.fitzroy.id)).toBe(-2);
  });
  it("an unknown variant cannot be recorded at all: rejected, sequence advances, nothing is written", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, [{ variantId: randomUUID(), qty: 1, unitPriceMinor: 100 }])), w.cmd("sale.create", saleOf(w, sid, sampleLines(w), { receiptNo: "FIT-2-000002" }))]);
    expect(r.body.results.map((x: { status: string; reason?: string }) => `${x.status}:${x.reason ?? ""}`)).toEqual(["rejected:unknown_variant", "accepted:"]);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sale`)).rows[0]).toEqual({ n: 1 });
  });
  it("a reused receipt number is kept under a suffixed number and flagged", async () => {
    const w = await posWorld(h); const sid = await open(w);
    await w.push([w.cmd("sale.create", saleOf(w, sid, sampleLines(w)))]);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, sampleLines(w)))]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["receipt_no_reused"] });
    const nos = (await h.db.execute(sql`select receipt_no from shelfline.sale order by received_at`)).rows.map((x) => String(x.receipt_no));
    expect(nos[0]).toBe("FIT-2-000001"); expect(nos[1]).toMatch(/^FIT-2-000001~[0-9a-f]{8}$/);
  });
  it("a payment that does not cover the payable is flagged; no session, a closed session and an unknown customer are flagged, never refused", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const short = saleOf(w, sid, sampleLines(w), { payments: [{ tender: "card", amountMinor: 1000 }], receiptNo: "R1" });
    const noSession = saleOf(w, randomUUID(), sampleLines(w), { receiptNo: "R2" });
    await h.db.execute(sql`update shelfline.register_session set status = 'closed' where id = ${sid}`);
    const late = saleOf(w, sid, sampleLines(w), { receiptNo: "R3", customerId: randomUUID() });
    const r = await w.push([w.cmd("sale.create", short), w.cmd("sale.create", noSession), w.cmd("sale.create", late)]);
    expect(r.body.results.map((x: { flags: string[] }) => x.flags)).toEqual([["payment_mismatch", "late_sale"], ["no_session"], ["late_sale", "unknown_customer"]]);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sale`)).rows[0]).toEqual({ n: 3 });
    expect((await h.db.execute(sql`select session_id, customer_id from shelfline.sale where receipt_no = 'R2'`)).rows[0]).toEqual({ session_id: null, customer_id: null });
  });
  it("the server prices with the tax rule in force for the location and date: a regional rate the till did not know is flagged", async () => {
    const w = await posWorld(h); const sid = await open(w);
    await w.owner.post(`/tax-classes/${w.gst.id}/rates`, { region: "AU-WA", rateBp: 1200, inclusive: true, validFrom: "2026-01-01", validTo: "2030-01-01" }); // overlaps the default? different region: allowed
    await w.owner.patch(`/locations/${w.fitzroy.id}`, { taxRegion: "AU-WA" });
    const stale = await w.push([w.cmd("sale.create", saleOf(w, sid, sampleLines(w), { receiptNo: "R1" }))]);                 // till still uses 10%
    expect(stale.body.results[0].flags).toEqual(["price_mismatch"]);
    const aware = await w.push([w.cmd("sale.create", saleOf(w, sid, sampleLines(w), { receiptNo: "R2", rate: 1200 }))]);       // till knows 12%
    expect(aware.body.results[0].status).toBe("accepted");
    expect((await h.db.execute(sql`select distinct tax_rate_bp from shelfline.sale_line l join shelfline.sale s on s.id = l.sale_id where s.receipt_no = 'R2'`)).rows).toEqual([{ tax_rate_bp: 1200 }]);
  });
});

describe("discount authority", () => {
  const big = (w: W): Line[] => [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995, discountMinor: 4399, discountReason: "price match" }]; // 20.0%, limit is 10%
  async function managerToken(w: W, code = "204", pin = "7313") {
    const r = await h.http().post("/pos/approve").set("Authorization", `Bearer ${w.tok}`).set("x-device-key", w.device.key).send({ managerEmployeeCode: code, pin, kind: "discount" });
    return r;
  }
  async function withManagerStaff(w: W) { await w.owner.put(`/users/${w.manager.id}/assignments`, { assignments: [{ role: "store_manager", locationId: w.fitzroy.id }] }); await w.owner.post(`/users/${w.manager.id}/pin`, { pin: "7313" }).catch(() => undefined); }
  async function managerWithCode(w: W) {
    const m = (await w.owner.post("/users", { email: "m2@kestrel.test", name: "Marcus T.", employeeCode: "204", pin: "7313", assignments: [{ role: "store_manager", locationId: w.fitzroy.id }] })).body;
    return m.id as string;
  }
  it("over the cashier's limit with no approval: accepted but flagged discount_unapproved; within the limit: fine", async () => {
    const w = await posWorld(h); const sid = await open(w);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, big(w), { receiptNo: "R1" })), w.cmd("sale.create", saleOf(w, sid, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995, discountMinor: 2199 }], { receiptNo: "R2" }))]);
    expect(r.body.results.map((x: { flags?: string[] }) => x.flags ?? [])).toEqual([["discount_unapproved"], []]);
    void withManagerStaff;
  });
  it("a manager's PIN on the till issues an approval token; with it the sale is clean and the approver is recorded", async () => {
    const w = await posWorld(h); const sid = await open(w); const mid = await managerWithCode(w);
    const a = await managerToken(w);
    expect(a.status).toBe(200); expect(a.body.approver).toMatchObject({ id: mid, name: "Marcus T." });
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, big(w).map((l) => ({ ...l, approvalToken: a.body.approvalToken }))))]);
    expect(r.body.results[0].status).toBe("accepted");
    expect((await h.db.execute(sql`select approved_by from shelfline.sale_line`)).rows[0]).toEqual({ approved_by: mid });
    expect((await w.owner.get("/audit?action=sale.approval_granted")).body).toHaveLength(1);
  });
  it("approval fails for a cashier, a wrong PIN, or an unknown code; a token for another device or a garbage token does not count", async () => {
    const w = await posWorld(h); const sid = await open(w); await managerWithCode(w);
    expect((await managerToken(w, "117", "4821")).status).toBe(403);       // a cashier cannot approve
    expect((await managerToken(w, "204", "0000")).status).toBe(401);
    expect((await managerToken(w, "999", "7313")).status).toBe(401);
    const dev2 = (await w.owner.post("/devices", { kind: "pos", locationId: w.fitzroy.id, registerId: w.register.id, name: "second iPad" })).body;
    const tok2 = (await h.http().post("/pos/approve").set("Authorization", `Bearer ${w.tok}`).set("x-device-key", dev2.key).send({ managerEmployeeCode: "204", pin: "7313", kind: "discount" })).body.approvalToken;
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, big(w).map((l) => ({ ...l, approvalToken: tok2 })), { receiptNo: "R1" })), w.cmd("sale.create", saleOf(w, sid, big(w).map((l) => ({ ...l, approvalToken: "garbage" })), { receiptNo: "R2" }))]);
    expect(r.body.results.map((x: { flags: string[] }) => x.flags)).toEqual([["discount_unapproved"], ["discount_unapproved"]]);
  });
  it("a manager ringing the sale themselves needs no token", async () => {
    const w = await posWorld(h); const sid = await open(w); const mid = await managerWithCode(w);
    const r = await w.push([w.cmd("sale.create", saleOf(w, sid, big(w)), { actorId: mid })]);
    expect(r.body.results[0].status).toBe("accepted");
  });
});

describe("customers", () => {
  it("customer.create then a sale for that customer; a duplicate email becomes a merge candidate; the replica carries customers", async () => {
    const w = await posWorld(h); const sid = await open(w); const cid = randomUUID(), dup = randomUUID();
    const r = await w.push([w.cmd("customer.create", { customerId: cid, name: "Sam Okafor", email: "sam@example.test", phone: "0400 000 111" }), w.cmd("customer.create", { customerId: dup, name: "Samuel O.", email: "SAM@example.test" }), w.cmd("sale.create", saleOf(w, sid, sampleLines(w), { customerId: cid }))]);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["accepted", "accepted_flagged", "accepted"]);
    expect((await h.db.execute(sql`select customer_id from shelfline.sale`)).rows[0]).toEqual({ customer_id: cid });
    expect((await h.db.execute(sql`select email, notes from shelfline.customer where id = ${dup}`)).rows[0]).toMatchObject({ email: null });
    const mc = (await w.owner.get("/sync/exceptions")).body.find((e: { kind: string }) => e.kind === "merge_candidate");
    expect(mc.detail).toMatchObject({ existingCustomerId: cid });
    const snap = (await h.http().get("/sync/snapshot").set("Authorization", `Bearer ${w.tok}`)); let items = snap.body.items; let next = snap.body.next;
    while (next) { const pg = await h.http().get(`/sync/snapshot?after=${encodeURIComponent(next)}`).set("Authorization", `Bearer ${w.tok}`); items = items.concat(pg.body.items); next = pg.body.next; }
    expect(items.filter((i: { type: string }) => i.type === "customer").map((i: { id: string }) => i.id).sort()).toEqual([cid, dup].sort());
    expect(items.find((i: { type: string }) => i.type === "location").data).toMatchObject({ cashierDiscountLimitBp: 1000 });
  });
});
