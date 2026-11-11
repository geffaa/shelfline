import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { zonedInstant } from "../src/common/business-day";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); w = await posWorld(h, { stock: 100 });
  session = randomUUID(); expect((await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 30000 })])).body.results[0].status).toBe("accepted");
});
const TZ = "Australia/Melbourne"; const at = (date: string, hm: string) => new Date(zonedInstant(date, hm, TZ)).toISOString();

/** A sale from the till, then moved to the day and time we want (the server stamps dates from the device clock). */
async function sell(lines: { variantId: string; qty: number; unitPriceMinor: number }[], date: string, hm = "12:00", o: { late?: boolean } = {}) {
  const priced = priceCart(lines.map((l) => ({ ...l, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const sale = { saleId, sessionId: session, receiptNo: `R-${saleId.slice(0, 6)}`, customerId: null, lines: lines.map((l) => ({ ...l, discountMinor: 0 })), payments: [{ tender: "card", amountMinor: priced.payableMinor }],
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null };
  expect((await w.push([w.cmd("sale.create", sale)])).body.results[0].status).toBe("accepted");
  await h.db.execute(sql`update shelfline.sale set local_date = ${date}::date, effective_at = ${at(date, hm)}::timestamptz, client_ts = ${at(date, hm)}::timestamptz ${o.late ? sql`` : sql`, received_at = ${at(date, hm)}::timestamptz`} where id = ${saleId}`);
  return saleId;
}
async function refundOf(saleId: string, lineNo: number, qty: number, date: string, o: { refundedQty?: number; refundedMinor?: number; refundedTax?: number } = {}) {
  const line = (await h.db.execute(sql`select qty, total_minor, tax_minor from shelfline.sale_line where sale_id = ${saleId} and line_no = ${lineNo}`)).rows[0] as { qty: number; total_minor: number; tax_minor: number };
  const a = refundAmount({ qty: line.qty, refundedQty: o.refundedQty ?? 0, totalMinor: line.total_minor, refundedMinor: o.refundedMinor ?? 0, taxMinor: line.tax_minor, refundedTaxMinor: o.refundedTax ?? 0 }, qty);
  const refundId = randomUUID();
  const r = await w.push([w.cmd("refund.create", { refundId, saleId, sessionId: session, tender: "card", reason: "wrong_size", lines: [{ saleLineNo: lineNo, qty, amountMinor: a.amountMinor, taxMinor: a.taxMinor, restock: true }], totalMinor: a.amountMinor })]);
  expect(["accepted", "accepted_flagged"], JSON.stringify(r.body)).toContain(r.body.results[0].status);
  await h.db.execute(sql`update shelfline.refund set local_date = ${date}::date, at = ${at(date, "15:00")}::timestamptz where id = ${refundId}`);
  return { refundId, ...a };
}
const rule = (o: object = {}) => w.owner.post("/commission/rules", { scopeKind: "default", validFrom: "2025-01-01", basis: "net_ex_tax", rateBp: 400, splitMode: "seller", ...o });
const period = async (from: string, to: string) => { const r = await w.owner.post("/commission/periods", { from, to }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; };
const recalc = async () => { const r = await w.owner.post("/commission/recalculate"); expect(r.status).toBe(200); return r.body; };
const people = async (p: string) => (await w.owner.get(`/commission/periods/${p}/statements`)).body.people as { userId: string; user: string; earnedMinor: number; clawbackMinor: number; adjustMinor: number; netMinor: number }[];
const net = async (p: string, uid = w.cashier.id) => (await people(p)).find((x) => x.userId === uid)?.netMinor ?? 0;
const dump = async () => (await h.db.execute(sql`select source_kind, source_id, line_no, user_id, kind, amount_minor, base_minor, rule_id, period_id, late from shelfline.commission_entry order by source_id, line_no, user_id, kind`)).rows;
/** A manual punch pair for someone, in store time. */
const worked = async (userId: string, date: string, from: string, to: string) => { for (const [kind, hm] of [["in", from], ["out", to]] as const) { const r = await w.mgr.post("/timesheets/corrections", { userId, locationId: w.fitzroy.id, kind, at: at(date, hm), reason: "test" }); expect(r.status, JSON.stringify(r.body)).toBe(201); } };

describe("the golden case and the rule versions", () => {
  it("A$219.95 at 4% of the amount without GST is A$8.00, and a full refund takes it back to nothing", async () => {
    await rule(); const p = await period("2025-03-01", "2025-03-14");
    const s = await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05");
    await recalc(); expect(await net(p)).toBe(800);
    expect((await dump())[0]).toMatchObject({ kind: "earn", amount_minor: 800, base_minor: 19995, user_id: w.cashier.id });
    await refundOf(s, 0, 1, "2025-03-06"); await recalc();
    expect(await net(p)).toBe(0); expect((await people(p))[0]).toMatchObject({ earnedMinor: 800, clawbackMinor: -800, netMinor: 0 });
  });
  it("a part refund claws back a proportional part, and the rest takes exactly what is left", async () => {
    await rule(); const p = await period("2025-03-01", "2025-03-14");
    const s = await sell([{ variantId: w.v[1]!.id, qty: 3, unitPriceMinor: 8900 }], "2025-03-05"); await recalc(); const earned = await net(p); expect(earned).toBe(Math.round((26700 - 2427) * 0.04));
    const one = await refundOf(s, 0, 1, "2025-03-06"); await recalc(); const afterOne = await net(p); expect(afterOne).toBeGreaterThan(earned * 0.6); expect(afterOne).toBeLessThan(earned);
    await refundOf(s, 0, 2, "2025-03-07", { refundedQty: 1, refundedMinor: one.amountMinor, refundedTax: one.taxMinor }); await recalc(); expect(await net(p)).toBe(0);
  });
  it("each sale keeps the rate in force on its own day; a new version never rewrites the past", async () => {
    expect((await rule()).status).toBe(201); const p = await period("2025-03-01", "2025-03-31");
    expect((await rule({ validFrom: "2025-03-15", rateBp: 600, note: "spring" })).body).toMatchObject({ version: 2 });
    expect((await rule({ validFrom: "2025-03-15", rateBp: 700 })).body.code).toBe("version_date_taken");
    await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-10"); await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-20");
    await recalc(); expect((await dump()).map((e) => Number(e.amount_minor)).sort((a, b) => a - b)).toEqual([800, 1200]);   // 4% then 6% of 199.95
    const sets = (await w.owner.get("/commission/rules")).body; expect(sets[0].versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    await expect(h.db.execute(sql`update shelfline.commission_rule set rate_bp = 1 where version = 1`)).rejects.toThrow();
  });
  it("the narrowest rule wins; a version switched off excludes a brand; margin uses cost", async () => {
    await h.db.execute(sql`update shelfline.product set brand = 'Tempra'`);
    await rule(); await rule({ scopeKind: "brand", scopeValue: "TEMPRA", rateBp: 1000, basis: "margin" }); await rule({ scopeKind: "variant", scopeValue: w.v[2]!.id, rateBp: 0, enabled: false });
    const p = await period("2025-03-01", "2025-03-14");
    await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await sell([{ variantId: w.v[2]!.id, qty: 1, unitPriceMinor: 3400 }], "2025-03-05"); await recalc();
    // the shoe is under the brand rule: 10% of (net 199.95 less cost 50.00); the variant that is switched off earns nothing
    expect(await net(p)).toBe(1500); expect((await dump())).toHaveLength(1);
  });
  it("preview shows the rule and the amount before anything is sold", async () => {
    await rule(); await rule({ scopeKind: "location", scopeValue: w.fitzroy.id, rateBp: 500, validFrom: "2025-02-01" });
    const q = (b: object = {}) => w.owner.post("/commission/preview", { variantId: w.v[0]!.id, locationId: w.fitzroy.id, date: "2025-03-05", qty: 1, totalMinor: 21995, ...b });
    expect((await q()).body).toMatchObject({ rule: { scopeKind: "location", rateBp: 500 }, taxMinor: 2000, baseMinor: 19995, commissionMinor: 1000 });
    expect((await q({ locationId: w.southYarra.id })).body).toMatchObject({ rule: { scopeKind: "default", rateBp: 400 }, commissionMinor: 800 });
    expect((await q({ date: "2024-12-01" })).body.rule).toBeNull();
  });
});

describe("splitting between people", () => {
  it("equal shares between whoever was clocked in; the cent goes to a person, never lost", async () => {
    await rule({ splitMode: "equal" }); const p = await period("2025-03-01", "2025-03-14");
    await worked(w.cashier.id, "2025-03-05", "09:00", "17:00"); await worked(w.manager.id, "2025-03-05", "10:00", "17:00");
    await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05", "12:00"); await sell([{ variantId: w.v[2]!.id, qty: 1, unitPriceMinor: 3400 }], "2025-03-05", "09:30");   // second sale: manager not in yet
    await recalc(); const t = await people(p); const byId = Object.fromEntries(t.map((x) => [x.userId, x.netMinor]));
    expect(byId[w.cashier.id]).toBe(400 + 124 + 0); expect(byId[w.manager.id]).toBe(400);   // 800 split 400/400; 3400 -> 3091 net -> 124, all to the only person in
    expect(t.reduce((a, x) => a + x.netMinor, 0)).toBe(800 + 124);
  });
  it("weighted by role, and a pool shared by the hours worked that day", async () => {
    await rule({ splitMode: "weighted", weights: { cashier: 100, store_manager: 300 } }); const p = await period("2025-03-01", "2025-03-14");
    await worked(w.cashier.id, "2025-03-05", "09:00", "17:00"); await worked(w.manager.id, "2025-03-05", "09:00", "13:00");
    await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05", "11:00"); await recalc();
    expect(await net(p, w.cashier.id)).toBe(200); expect(await net(p, w.manager.id)).toBe(600);
    await rule({ splitMode: "hours_pool", validFrom: "2025-03-01" }); await recalc();      // 480 vs 240 minutes worked
    expect(await net(p, w.cashier.id)).toBe(533); expect(await net(p, w.manager.id)).toBe(267);
  });
  it("with nobody clocked in the seller keeps it", async () => {
    await rule({ splitMode: "equal" }); const p = await period("2025-03-01", "2025-03-14"); await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await recalc();
    expect(await net(p)).toBe(800);
  });
});

describe("periods", () => {
  it("rebuilding an open period gives identical rows, and keeps manual adjustments", async () => {
    await rule({ splitMode: "equal" }); const p = await period("2025-03-01", "2025-03-14"); await worked(w.cashier.id, "2025-03-05", "09:00", "17:00"); await worked(w.manager.id, "2025-03-05", "09:00", "17:00");
    const s = await sell([{ variantId: w.v[1]!.id, qty: 3, unitPriceMinor: 8900 }, { variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await refundOf(s, 0, 2, "2025-03-08");
    expect((await w.owner.post("/commission/adjustments", { userId: w.cashier.id, amountMinor: 1500, reason: "SPIFF" })).status).toBe(201);
    await recalc(); const a = (await dump()).map(({ source_id, line_no, user_id, kind, amount_minor, base_minor, rule_id, period_id }) => ({ source_id, line_no, user_id, kind, amount_minor, base_minor, rule_id, period_id }));
    await recalc(); await recalc(); const b = (await dump()).map(({ source_id, line_no, user_id, kind, amount_minor, base_minor, rule_id, period_id }) => ({ source_id, line_no, user_id, kind, amount_minor, base_minor, rule_id, period_id }));
    expect(b).toEqual(a); expect(a.some((e) => e.kind === "adjust")).toBe(true); expect(a.some((e) => e.kind === "clawback")).toBe(true); void p;
  });
  it("a locked period never changes: rules, timesheets and late sales go to the next open period instead", async () => {
    await rule(); const p1 = await period("2025-03-01", "2025-03-14"); const p2 = await period("2025-03-15", "2025-03-28");
    const s1 = await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-20"); await recalc();
    expect((await w.owner.post(`/commission/periods/${p2}/lock`)).body.code).toBe("earlier_period_open");
    const lock = await w.owner.post(`/commission/periods/${p1}/lock`); expect(lock.status, JSON.stringify(lock.body)).toBe(200); expect(lock.body).toMatchObject({ status: "locked", people: 1, netMinor: 800 });
    const before = (await dump()).filter((e) => e.period_id === p1);
    // a better rate, backdated into the closed period; a sale and a refund that only now reached the server
    await rule({ validFrom: "2025-03-02", rateBp: 1000 });
    await new Promise((r) => setTimeout(r, 30));                      // the lock and a sale must not share a millisecond
    const late = await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-06", "12:00", { late: true });
    await refundOf(s1, 0, 1, "2025-03-10", {}); await h.db.execute(sql`update shelfline.refund set at = now() where sale_id = ${s1}`);
    await recalc(); await recalc();
    expect((await dump()).filter((e) => e.period_id === p1)).toEqual(before); expect(await net(p1)).toBe(800);
    const inP2 = (await dump()).filter((e) => e.period_id === p2);
    expect(inP2.find((e) => e.source_id === late)).toMatchObject({ late: true, amount_minor: 2000 });                // new rate: it was never booked in the closed period
    expect(inP2.find((e) => e.kind === "clawback")).toMatchObject({ amount_minor: -800, late: true });                 // gives back what was actually paid out, at the rule that earned it
    expect(await net(p2)).toBe(2000 + 2000 - 800);                                                                      // the 20 March sale, the late sale, and the clawback
    // closed rows cannot be touched even by hand
    await expect(h.db.execute(sql`delete from shelfline.commission_entry where period_id = ${p1}`)).rejects.toThrow(); await expect(h.db.execute(sql`update shelfline.commission_period set end_date = '2025-03-30' where id = ${p1}`)).rejects.toThrow();
    await expect(h.db.execute(sql`update shelfline.commission_statement set net_minor = 1`)).rejects.toThrow();
    expect((await w.owner.post(`/commission/periods/${p1}/lock`)).body.code).toBe("already_locked");
  });
  it("corrections after a close are adjust entries in the next open period, and need one to exist", async () => {
    await rule(); const p1 = await period("2025-03-01", "2025-03-14"); await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await recalc();
    expect((await w.owner.post(`/commission/periods/${p1}/lock`)).status).toBe(200);
    expect((await w.owner.post("/commission/adjustments", { userId: w.cashier.id, amountMinor: -300, reason: "miscount" })).body.code).toBe("no_open_period");
    const p2 = await period("2025-03-15", "2025-03-28"); const r = await w.owner.post("/commission/adjustments", { userId: w.cashier.id, amountMinor: -300, reason: "miscount" }); expect(r.body.periodId).toBe(p2);
    expect(await net(p1)).toBe(800); expect(await net(p2)).toBe(-300); expect((await w.owner.post("/commission/adjustments", { userId: w.cashier.id, amountMinor: 0, reason: "nothing" })).status).toBe(400);
    expect((await w.owner.get("/audit?action=commission.adjust")).body.length).toBe(1);
  });
  it("periods cannot overlap, cannot close before they end, and the statement lists every line behind the number", async () => {
    await rule(); const p1 = await period("2025-03-01", "2025-03-14"); expect((await w.owner.post("/commission/periods", { from: "2025-03-10", to: "2025-03-20" })).body.code).toBe("period_overlap"); expect((await w.owner.post("/commission/periods", { from: "2025-03-20", to: "2025-03-10" })).status).toBe(400);
    const today = new Date().toISOString().slice(0, 10); const now = await period(today, today); expect((await w.owner.post(`/commission/periods/${now}/lock`)).body.code).toBe("period_not_ended");
    const s = await sell([{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995 }], "2025-03-05"); await refundOf(s, 0, 1, "2025-03-06"); await recalc();
    const d = (await w.owner.get(`/commission/periods/${p1}/statements/${w.cashier.id}`)).body; expect(d.user).toBe("Priya N."); expect(d.entries.map((e: { kind: string; amountMinor: number }) => `${e.kind}:${e.amountMinor}`)).toEqual(["earn:800", "clawback:-800"]);
    expect(d.entries[0]).toMatchObject({ receiptNo: expect.stringMatching(/^R-/), item: expect.stringContaining("TG3-A"), rateBp: 400, basis: "net_ex_tax", scopeKind: "default" }); expect(d.entries[1].receiptNo).toBe(d.entries[0].receiptNo);
    const csv = await w.owner.get(`/commission/periods/${p1}/export`); expect(csv.text).toContain("Priya N.,8.00,-8.00,0.00,0.00,2");
  });
});

describe("who may do what", () => {
  it("only owner-level commission permissions: finance can read and write rules but not close; a store manager sees nothing", async () => {
    await rule(); const p = await period("2025-03-01", "2025-03-14");
    await w.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-12", assignments: [{ role: "finance", locationId: null }] });
    const fin = w.as((await w.login("fin@kestrel.test", "finance-password-12")).body.token);
    expect((await fin.get("/commission/rules")).status).toBe(200); expect((await fin.post("/commission/rules", { scopeKind: "location", scopeValue: w.fitzroy.id, validFrom: "2025-01-01", basis: "net_ex_tax", rateBp: 100, splitMode: "seller" })).status).toBe(201);
    expect((await fin.post(`/commission/periods/${p}/lock`)).status).toBe(403);
    for (const call of [() => w.mgr.get("/commission/rules"), () => w.mgr.get("/commission/periods"), () => w.mgr.post("/commission/rules", {}), () => w.mgr.get(`/commission/periods/${p}/statements`)]) expect((await call()).status).toBe(403);
    expect([401, 403]).toContain((await h.http().get("/commission/rules").set("Authorization", `Bearer ${w.tok}`)).status);     // a till token is not an admin
    expect((await w.owner.post("/commission/rules", { scopeKind: "location", scopeValue: randomUUID(), validFrom: "2025-01-01", basis: "net_ex_tax", rateBp: 100, splitMode: "seller" })).status).toBe(404);
    expect((await w.owner.post("/commission/rules", { scopeKind: "default", validFrom: "2025-01-01", basis: "net_ex_tax", rateBp: 10001, splitMode: "seller" })).status).toBe(400);
  });
});
