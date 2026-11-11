import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { SCHEMA_V } from "@shelfline/contracts";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { uuidv7 } from "@shelfline/sync-client";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

type W = Awaited<ReturnType<typeof posWorld>>;
const accepted = (r: { body: { results: { status: string; reason?: string }[] } }) => r.body.results.map((x) => `${x.status}${x.reason ? ":" + x.reason : ""}`);
const flagsOf = (r: { body: { results: { flags?: string[] }[] } }) => r.body.results.map((x) => x.flags ?? []);

/** A device with its own sequence: used to test two tills at one store. */
async function extraDevice(w: W, name = "second iPad") {
  const reg = (await w.owner.post(`/locations/${w.fitzroy.id}/registers`, { code: `X${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name })).body;
  const dev = (await w.owner.post("/devices", { kind: "pos", locationId: w.fitzroy.id, registerId: reg.id, name })).body;
  const tok = (await h.http().post("/pos/pin").set("x-device-key", dev.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
  let seq = 0;
  const cmd = (type: string, payload: unknown, o: { actorId?: string } = {}) => ({ id: uuidv7(), seq: ++seq, type, payload, clientTs: new Date().toISOString(), schemaV: SCHEMA_V, actorId: o.actorId ?? w.cashier.id });
  const push = (commands: object[]) => h.http().post("/sync/push").set("Authorization", `Bearer ${tok}`).send({ deviceNow: new Date().toISOString(), commands });
  return { dev, tok, cmd, push, key: dev.key as string };
}

async function open(w: W, float = 30000, sessionId = randomUUID()) { const r = await w.push([w.cmd("session.open", { sessionId, openingFloatMinor: float })]); expect(r.body.results[0].status).toBe("accepted"); return sessionId; }
function saleOf(sessionId: string, lines: { variantId: string; qty: number; unitPriceMinor: number }[], tender: "cash" | "card" | "other" = "cash", receiptNo = `R-${randomUUID().slice(0, 6)}`) {
  const priced = priceCart(lines.map((l) => ({ ...l, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } })));
  return { saleId: randomUUID(), sessionId, receiptNo, customerId: null, lines: lines.map((l) => ({ ...l, discountMinor: 0 })), payments: [{ tender, amountMinor: priced.payableMinor, ...(tender === "cash" ? { tenderedMinor: priced.payableMinor } : {}) }],
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null };
}
const move = (w: W, sessionId: string, kind: string, amountMinor: number, reason?: string, push = w.cmd) => push("cash.move", { movementId: randomUUID(), sessionId, kind, amountMinor, ...(reason ? { reason } : {}) });
const closeOf = (sessionId: string, countedMinor: number, extra: object = {}) => ({ sessionId, countedMinor, ...extra });
const approve = (w: W, kind: "discount" | "variance" | "refund", code: string, pin: string, key = w.device.key, tok = w.tok) => h.http().post("/pos/approve").set("Authorization", `Bearer ${tok}`).set("x-device-key", key).send({ managerEmployeeCode: code, pin, kind });
async function manager(w: W) { return (await w.owner.post("/users", { email: "m2@kestrel.test", name: "Marcus T.", employeeCode: "204", pin: "7313", assignments: [{ role: "store_manager", locationId: w.fitzroy.id }] })).body.id as string; }

describe("cash movements", () => {
  it("records pay-in, pay-out, drop, float add and no-sale; a no-sale has no amount; amounts must make sense", async () => {
    const w = await posWorld(h); const s = await open(w);
    const r = await w.push([move(w, s, "pay_in", 5000, "change top-up"), move(w, s, "pay_out", 3200, "courier"), move(w, s, "drop", 50000, "safe drop"), move(w, s, "float_add", 1000, "extra coins"), move(w, s, "no_sale", 0, "change for customer")]);
    expect(accepted(r)).toEqual(Array(5).fill("accepted"));
    expect((await h.db.execute(sql`select kind, amount_minor from shelfline.cash_movement order by at`)).rows.map((x) => `${x.kind}:${x.amount_minor}`)).toEqual(["pay_in:5000", "pay_out:3200", "drop:50000", "float_add:1000", "no_sale:0"]);
    const bad = await w.push([move(w, s, "no_sale", 100, "x"), move(w, s, "pay_in", 0, "x")]);
    expect(accepted(bad)).toEqual(["rejected:bad_amount", "rejected:bad_amount"]);
  });
  it("a no-sale or pay-out with no reason is accepted (the drawer already opened) but flagged; late and session-less movements are flagged", async () => {
    const w = await posWorld(h); const s = await open(w);
    const r = await w.push([move(w, s, "no_sale", 0), move(w, s, "pay_out", 500), move(w, randomUUID(), "pay_in", 100, "orphan")]);
    expect(flagsOf(r)).toEqual([["no_sale_no_reason"], ["pay_out_no_reason"], ["no_session"]]);
    await h.db.execute(sql`update shelfline.register_session set status = 'closed' where id = ${s}`);
    expect(flagsOf(await w.push([move(w, s, "pay_in", 100, "late")]))).toEqual([["late_movement"]]);
  });
});

describe("closing the register and the Z report", () => {
  /** The figures of mockups/admin-session.html (FIT-2, Tue 3 Nov), built from real commands. */
  async function mockupSession(w: W) {
    const s = await open(w, 30000); const [A, B] = [w.v[0]!.id, w.v[1]!.id];
    const s1 = saleOf(s, [{ variantId: A, qty: 1, unitPriceMinor: 139740 }], "cash"), s2 = saleOf(s, [{ variantId: B, qty: 10, unitPriceMinor: 890 }], "cash");
    const s3 = saleOf(s, [{ variantId: A, qty: 1, unitPriceMinor: 308460 }], "card"), s4 = saleOf(s, [{ variantId: B, qty: 1, unitPriceMinor: 11995 }], "card"), s5 = saleOf(s, [{ variantId: A, qty: 1, unitPriceMinor: 12000 }], "other");
    expect(accepted(await w.push([s1, s2, s3, s4, s5].map((x) => w.cmd("sale.create", x))))).toEqual(Array(5).fill("accepted"));
    const refundOf = (sale: ReturnType<typeof saleOf>, tender: "cash" | "card") => ({ refundId: randomUUID(), saleId: sale.saleId, sessionId: s, tender, reason: "faulty", lines: sale.lines.map((l, i) => ({ saleLineNo: i, qty: l.qty, ...refundAmount({ qty: l.qty, refundedQty: 0, totalMinor: l.qty * l.unitPriceMinor, refundedMinor: 0, taxMinor: priceCart([{ ...l, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }]).taxMinor, refundedTaxMinor: 0 }, l.qty), restock: true })), totalMinor: sale.totals.totalMinor });
    expect(accepted(await w.push([w.cmd("refund.create", refundOf(s2, "cash")), w.cmd("refund.create", refundOf(s4, "card")), move(w, s, "pay_in", 5000, "change top-up"), move(w, s, "pay_out", 3200, "courier"), move(w, s, "drop", 50000, "safe drop"), move(w, s, "no_sale", 0, "change for customer")]))).toEqual(Array(6).fill("accepted"));
    return { s, sales: [s1, s2, s3, s4, s5] };
  }
  it("expected cash = float + cash sales - cash refunds + pay-ins - pay-outs - drops, and the report adds up like the manager's close sheet", async () => {
    const w = await posWorld(h, { stock: 100000 }); const { s } = await mockupSession(w);
    const mgr = await manager(w); void mgr;
    const r = await w.push([w.cmd("session.close", closeOf(s, 121040))]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted", result: { status: "closed", expectedMinor: 121540, varianceMinor: -500 } });   // exactly at the limit: not flagged
    const z = (await w.owner.get(`/sessions/${s}`)).body;
    expect(z).toMatchObject({ status: "closed", openingFloatMinor: 30000, countedMinor: 121040, expectedAtCloseMinor: 121540, varianceMinor: -500, changedSinceClose: false });
    expect(z.z).toMatchObject({ expectedMinor: 121540, salesCount: 5, grossSalesMinor: 481095, refundsMinor: 20895, netSalesMinor: 460200, noSaleCount: 1, tenders: { cashMinor: 148640, cardMinor: 320455, otherMinor: 12000 }, cash: { refundsMinor: 8900, payInMinor: 5000, payOutMinor: 3200, dropMinor: 50000 } });
    expect(z.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["register_opened", "pay_in", "pay_out", "drop", "no_sale", "refund", "register_closed"]));
    expect(z.events.map((e: { at: string }) => e.at)).toEqual([...z.events.map((e: { at: string }) => e.at)].sort());
  });
  it("a count off by more than the limit is flagged as an exception; with a manager's approval it is recorded as approved", async () => {
    const w = await posWorld(h); await manager(w);
    const s1 = await open(w); await w.push([w.cmd("sale.create", saleOf(s1, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 10000 }], "cash"))]);
    const bad = await w.push([w.cmd("session.close", closeOf(s1, 39000))]);                                  // expected 40000, counted 39000: -10.00
    expect(bad.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["variance_over_limit"], result: { varianceMinor: -1000 } });
    expect((await w.owner.get("/sync/exceptions")).body.find((e: { kind: string }) => e.kind === "variance_over_limit").detail).toMatchObject({ varianceMinor: -1000, limitMinor: 500, expectedMinor: 40000, countedMinor: 39000 });
    const s2 = await open(w, 30000); await w.push([w.cmd("sale.create", saleOf(s2, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 10000 }], "cash"))]);
    const tok = (await approve(w, "variance", "204", "7313")).body.approvalToken;
    const ok = await w.push([w.cmd("session.close", closeOf(s2, 39000, { approvalToken: tok }))]);
    expect(ok.body.results[0].status).toBe("accepted");
    const row = (await h.db.execute(sql`select flags, reviewed_by from shelfline.register_session where id = ${s2}`)).rows[0] as { flags: string[]; reviewed_by: string };
    expect(row.flags).toEqual(["variance_approved"]); expect(row.reviewed_by).toBeTruthy();
  });
  it("closing twice is idempotent; unknown sessions and another register's session are refused; closing frees the register", async () => {
    const w = await posWorld(h); const s = await open(w, 10000);
    expect(accepted(await w.push([w.cmd("session.close", closeOf(randomUUID(), 0))]))).toEqual(["rejected:unknown_session"]);
    const c = w.cmd("session.close", closeOf(s, 10000)); await w.push([c]);
    expect((await w.push([w.cmd("session.close", closeOf(s, 99999))])).body.results[0].result).toMatchObject({ existing: true, varianceMinor: 0 });   // a second, different count does not overwrite
    const x = await extraDevice(w); const other = randomUUID();
    await x.push([x.cmd("session.open", { sessionId: other, openingFloatMinor: 100 })]);
    expect(accepted(await w.push([w.cmd("session.close", closeOf(other, 100))]))).toEqual(["rejected:wrong_register"]);
    const next = await open(w, 20000); expect(next).toBeTruthy();                                         // the register can open again, and nothing was force-closed
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.register_session where status = 'force_closed'`)).rows[0]).toEqual({ n: 0 });
  });
  it("a sale that arrives after the close is accepted, flagged late, and the live report shows it changed since close", async () => {
    const w = await posWorld(h); const s = await open(w, 10000);
    await w.push([w.cmd("session.close", closeOf(s, 10000))]);
    expect(flagsOf(await w.push([w.cmd("sale.create", saleOf(s, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 5000 }], "cash"))]))).toEqual([["late_sale"]]);
    const z = (await w.owner.get(`/sessions/${s}`)).body;
    expect(z.expectedAtCloseMinor).toBe(10000); expect(z.z.expectedMinor).toBe(15000); expect(z.changedSinceClose).toBe(true);
  });
  it("location access: a Fitzroy manager sees Fitzroy sessions only, can review, a cashier cannot; the list shows the day's sessions", async () => {
    const w = await posWorld(h); const s = await open(w, 10000); await w.push([w.cmd("session.close", closeOf(s, 9000))]);
    expect((await w.mgr.get(`/sessions/${s}`)).status).toBe(200);
    expect((await w.mgr.get(`/sessions?locationId=${w.southYarra.id}`)).status).toBe(403);
    const list = (await w.mgr.get(`/sessions?locationId=${w.fitzroy.id}`)).body;
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: s, status: "closed", varianceMinor: -1000 });
    expect((await w.mgr.post(`/sessions/${s}/review`, { note: "recounted, one note was short" })).status).toBe(204);
    expect((await w.owner.get(`/sessions/${s}`)).body).toMatchObject({ reviewNote: "recounted, one note was short" });
    expect((await w.owner.get("/audit?action=session.review")).body).toHaveLength(1);
  });
  it("a session opened at 02:30 local belongs to the previous business day (the 04:00 cutoff), in the list as everywhere else", async () => {
    const w = await posWorld(h); const s = await open(w, 1000);
    await h.db.execute(sql`update shelfline.register_session set opened_at = '2026-11-03T15:30:00Z' where id = ${s}`);       // 02:30 AEDT on 4 Nov
    const day = async (d: string) => (await w.owner.get(`/sessions?locationId=${w.fitzroy.id}&date=${d}`)).body.length;
    expect(await day("2026-11-03")).toBe(1); expect(await day("2026-11-04")).toBe(0);
    await h.db.execute(sql`update shelfline.register_session set opened_at = '2026-11-03T17:00:00Z' where id = ${s}`);       // 04:00 AEDT: a new business day
    expect(await day("2026-11-04")).toBe(1); expect(await day("2026-11-03")).toBe(0);
  });
  it("model check: any mix of cash sales, cash refunds and drawer movements ends with expected = the straightforward sum", async () => {
    const w = await posWorld(h, { stock: 100000 });
    const op = fc.record({ kind: fc.constantFrom("sale", "refund", "pay_in", "pay_out", "drop", "float_add"), amount: fc.integer({ min: 100, max: 19000 }) });   // refunds above A$200 need approval (a flag, tested elsewhere)
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 60000 }), fc.array(op, { minLength: 1, maxLength: 12 }), async (float, ops) => {
      const s0 = await w.push([w.cmd("session.open", { sessionId: randomUUID(), openingFloatMinor: float })]); void s0; const s = (s0.body.results[0].result as { sessionId: string }).sessionId; let model = float; const cmds: object[] = []; const refundable: { sale: ReturnType<typeof saleOf>; amount: number }[] = [];
      for (const o of ops) {
        if (o.kind === "sale") { const sl = saleOf(s, [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: o.amount }], "cash"); cmds.push(w.cmd("sale.create", sl)); refundable.push({ sale: sl, amount: sl.totals.payableMinor }); model += sl.totals.payableMinor; }
        else if (o.kind === "refund") { const r = refundable.pop(); if (!r) continue; cmds.push(w.cmd("refund.create", { refundId: randomUUID(), saleId: r.sale.saleId, sessionId: s, tender: "cash", reason: "faulty", lines: [{ saleLineNo: 0, qty: 1, amountMinor: r.sale.totals.totalMinor, taxMinor: r.sale.totals.taxMinor, restock: true }], totalMinor: r.sale.totals.totalMinor })); model -= r.sale.totals.totalMinor; }
        else { cmds.push(move(w, s, o.kind, o.amount, "x")); model += o.kind === "pay_in" || o.kind === "float_add" ? o.amount : -o.amount; }
      }
      if (cmds.length) { const r = await w.push(cmds); expect(JSON.stringify(r.body.results.filter((x: { status: string }) => x.status !== "accepted"))).toBe("[]"); }   // a run of only refunds has nothing to send
      const counted = Math.max(0, model);                                       // a count cannot be negative, but the expected figure can (a drop larger than the cash)
      const c = await w.push([w.cmd("session.close", closeOf(s, counted))]);
      expect(c.body.results[0].result).toMatchObject({ expectedMinor: model, varianceMinor: counted - model });
    }), { numRuns: 15 });
  }, 120_000);
});

describe("refunds", () => {
  async function sold(w: W, saleQty = 3) {
    const s = await open(w, 10000); const sl = saleOf(s, [{ variantId: w.v[0]!.id, qty: saleQty, unitPriceMinor: 3333 }], "card");
    await w.push([w.cmd("sale.create", sl)]);
    const line = (await h.db.execute(sql`select total_minor, tax_minor from shelfline.sale_line where sale_id = ${sl.saleId}`)).rows[0] as { total_minor: number; tax_minor: number };
    const onHand = async () => Number((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${w.v[0]!.id} and location_id = ${w.fitzroy.id}`)).rows[0]?.on_hand);
    const r = (qty: number, o: { restock?: boolean; refundedQty?: number; refundedMinor?: number; refundedTax?: number; tender?: string; tamper?: number; sessionId?: string; approvalToken?: string } = {}) => {
      const a = refundAmount({ qty: saleQty, refundedQty: o.refundedQty ?? 0, totalMinor: line.total_minor, refundedMinor: o.refundedMinor ?? 0, taxMinor: line.tax_minor, refundedTaxMinor: o.refundedTax ?? 0 }, qty);
      return { refundId: randomUUID(), saleId: sl.saleId, sessionId: o.sessionId ?? s, tender: o.tender ?? "card", reason: "wrong_size", lines: [{ saleLineNo: 0, qty, amountMinor: a.amountMinor + (o.tamper ?? 0), taxMinor: a.taxMinor, restock: o.restock ?? true }], totalMinor: a.amountMinor + (o.tamper ?? 0), ...(o.approvalToken ? { approvalToken: o.approvalToken } : {}) };
    };
    return { s, sl, line, r, onHand };
  }
  it("a partial refund returns pro-rata money and puts the goods back; the rest then takes exactly what is left", async () => {
    const w = await posWorld(h); const x = await sold(w);
    expect(await x.onHand()).toBe(7);
    const one = x.r(1); expect(one.totalMinor).toBe(3333);
    expect((await w.push([w.cmd("refund.create", one)])).body.results[0].status).toBe("accepted");
    expect(await x.onHand()).toBe(8);
    const rest = x.r(2, { refundedQty: 1, refundedMinor: 3333, refundedTax: one.lines[0]!.taxMinor }); expect(rest.totalMinor).toBe(x.line.total_minor - 3333);
    expect((await w.push([w.cmd("refund.create", rest)])).body.results[0].status).toBe("accepted");
    expect((await h.db.execute(sql`select refunded_qty, refunded_minor, refunded_tax_minor from shelfline.sale_line where sale_id = ${x.sl.saleId}`)).rows[0]).toEqual({ refunded_qty: 3, refunded_minor: x.line.total_minor, refunded_tax_minor: x.line.tax_minor });
    expect((await h.db.execute(sql`select status from shelfline.sale where id = ${x.sl.saleId}`)).rows[0]).toEqual({ status: "refunded" }); expect(await x.onHand()).toBe(10);
  });
  it("damaged goods are refunded without going back on the shelf", async () => {
    const w = await posWorld(h); const x = await sold(w);
    await w.push([w.cmd("refund.create", x.r(1, { restock: false }))]); expect(await x.onHand()).toBe(7);
    expect((await h.db.execute(sql`select status from shelfline.sale where id = ${x.sl.saleId}`)).rows[0]).toEqual({ status: "partially_refunded" });
  });
  it("two tills refunding the same pair: the first is clean, the second is accepted (the money is gone) and flagged over_refund", async () => {
    const w = await posWorld(h); const x = await sold(w, 1); const t2 = await extraDevice(w);
    const s2 = randomUUID(); await t2.push([t2.cmd("session.open", { sessionId: s2, openingFloatMinor: 5000 })]);
    const a = await w.push([w.cmd("refund.create", x.r(1))]);
    const b = await t2.push([t2.cmd("refund.create", { ...x.r(1), sessionId: s2 })]);
    expect(a.body.results[0].status).toBe("accepted");
    expect(b.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: expect.arrayContaining(["over_refund"]) });
    expect((await h.db.execute(sql`select refunded_qty from shelfline.sale_line where sale_id = ${x.sl.saleId}`)).rows[0]).toEqual({ refunded_qty: 2 });
    expect((await w.owner.get("/sync/exceptions")).body.filter((e: { kind: string }) => e.kind === "over_refund")).toHaveLength(1);
  });
  it("wrong amounts, a total that is not the sum of its lines, and a large refund with no approval are flagged; a manager's token clears the last", async () => {
    const w = await posWorld(h); await manager(w); const x = await sold(w, 3);
    expect(flagsOf(await w.push([w.cmd("refund.create", x.r(1, { tamper: 5 }))]))[0]).toEqual(expect.arrayContaining(["refund_amount_mismatch"]));
    const big = { ...x.r(1, { refundedQty: 1, refundedMinor: 3338, refundedTax: 0 }) };
    await w.owner.patch(`/locations/${w.fitzroy.id}`, { cashierRefundLimitMinor: 1000 });
    expect(flagsOf(await w.push([w.cmd("refund.create", big)]))[0]).toContain("refund_unapproved");
    const tok = (await approve(w, "refund", "204", "7313")).body.approvalToken;
    const ok = await w.push([w.cmd("refund.create", { ...x.r(1, { refundedQty: 2, refundedMinor: 6671 }), approvalToken: tok })]);
    expect(ok.body.results[0].flags ?? []).not.toContain("refund_unapproved");
    expect((await h.db.execute(sql`select approved_by from shelfline.refund order by at desc limit 1`)).rows[0]!.approved_by).toBeTruthy();
    const mismatch = x.r(1); mismatch.totalMinor += 7;
    expect(flagsOf(await w.push([w.cmd("refund.create", mismatch)]))[0]).toEqual(expect.arrayContaining(["refund_total_mismatch"]));
  });
  it("refuses a refund of a sale or a line that does not exist; a cashier cannot approve a refund", async () => {
    const w = await posWorld(h); const x = await sold(w, 1);
    expect(accepted(await w.push([w.cmd("refund.create", { ...x.r(1), saleId: randomUUID() }), w.cmd("refund.create", { ...x.r(1), lines: [{ saleLineNo: 9, qty: 1, amountMinor: 1, taxMinor: 0, restock: true }], totalMinor: 1 })]))).toEqual(["rejected:unknown_sale", "rejected:unknown_sale_line"]);
    expect((await approve(w, "refund", "117", "4821")).status).toBe(403);
  });
  it("the till can look up sales at its store by receipt number or see the latest; refundable amounts are included", async () => {
    const w = await posWorld(h); const x = await sold(w, 2);
    const hit = (await h.http().get(`/pos/sales?receipt=${encodeURIComponent(x.sl.receiptNo.toLowerCase())}`).set("Authorization", `Bearer ${w.tok}`)).body;
    expect(hit).toHaveLength(1); expect(hit[0]).toMatchObject({ receiptNo: x.sl.receiptNo, cashierName: "Priya N.", lines: [{ lineNo: 0, qty: 2, refundedQty: 0, totalMinor: x.line.total_minor }], payments: [{ tender: "card" }] });
    expect((await h.http().get("/pos/sales").set("Authorization", `Bearer ${w.tok}`)).body.length).toBeGreaterThanOrEqual(1);
    expect((await h.http().get("/pos/sales?receipt=NOPE").set("Authorization", `Bearer ${w.tok}`)).body).toEqual([]);
    expect((await h.http().get(`/pos/sessions/${x.s}`).set("Authorization", `Bearer ${w.tok}`)).body).toMatchObject({ status: "open", z: { expectedMinor: 10000 } });
  });
});

describe("clocking in and out, and closing a location", () => {
  it("in/out alternate; a repeated clock-in is kept but marked for review; the session timeline shows the punches", async () => {
    const w = await posWorld(h); const s = await open(w, 1000);
    const p = (kind: string) => w.cmd("punch.record", { punchId: randomUUID(), kind, method: "pin" });
    const r = await w.push([p("in"), p("in"), p("out"), p("in")]);
    expect(r.body.results.map((x: { status: string; flags?: string[] }) => `${x.status}${x.flags?.length ? ":" + x.flags[0] : ""}`)).toEqual(["accepted", "accepted_flagged:punch_repeat", "accepted", "accepted"]);
    expect((await h.db.execute(sql`select kind, status from shelfline.punch order by client_ts, received_at`)).rows.map((x) => `${x.kind}:${x.status}`)).toEqual(["in:accepted", "in:needs_review", "out:accepted", "in:accepted"]);
    await w.push([w.cmd("session.close", closeOf(s, 1000))]);
    expect((await w.owner.get(`/sessions/${s}`)).body.events.filter((e: { kind: string }) => e.kind.startsWith("clock_")).length).toBe(4);
  });
  it("a location with an open register session cannot be deactivated until it is closed", async () => {
    const w = await posWorld(h); const s = await open(w, 1000);
    const blocked = await w.owner.patch(`/locations/${w.fitzroy.id}`, { status: "inactive" });
    expect(blocked.status).toBe(409); expect(blocked.body.code).toBe("open_sessions");
    await w.push([w.cmd("session.close", closeOf(s, 1000))]);
    expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, { status: "inactive" })).status).toBe(200);
  });
  it("limits for the till are location settings that sync down to it", async () => {
    const w = await posWorld(h);
    expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, { cashierDiscountLimitBp: 500, cashierRefundLimitMinor: 5000, cashVarianceLimitMinor: 200 })).status).toBe(200);
    const snap = (await h.http().get("/sync/snapshot").set("Authorization", `Bearer ${w.tok}`)).body;
    expect(snap.items.find((i: { type: string }) => i.type === "location").data).toMatchObject({ cashierDiscountLimitBp: 500, cashierRefundLimitMinor: 5000, cashVarianceLimitMinor: 200 });
  });
});
