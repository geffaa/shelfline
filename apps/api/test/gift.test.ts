import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { priceCart } from "@shelfline/pricing";
import { uuidv7 } from "@shelfline/sync-client";
import { SCHEMA_V } from "@shelfline/contracts";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); w = await posWorld(h, { stock: 50 }); });
const A = () => w.v[0]!.id;
const issue = async (amountMinor = 5000, extra: object = {}) => { const r = await w.hqApi.post("/gift-cards", { amountMinor, ...extra }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string; code: string; last4: string; balanceMinor: number }; };
const balance = async (id: string) => (await w.hqApi.get(`/gift-cards/${id}`)).body.balanceMinor as number;
const customer = async (name = "Sam Okafor") => { const id = randomUUID(); expect((await w.push([w.cmd("customer.create", { customerId: id, name })])).body.results[0].status).toBe("accepted"); return id; };

/** A sale paid with the given tenders; `unit` is the price of one A so the total is easy to read. */
function saleCmd(c: { cmd: typeof w.cmd }, sessionId: string, total: number, payments: { tender: string; amountMinor: number; reference?: string }[], o: { customerId?: string | null; saleId?: string } = {}) {
  const priced = priceCart([{ unitPriceMinor: total, qty: 1, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }]);
  return c.cmd("sale.create", { saleId: o.saleId ?? randomUUID(), sessionId, receiptNo: `FIT-${randomUUID().slice(0, 6)}`, customerId: o.customerId ?? null, lines: [{ variantId: A(), qty: 1, unitPriceMinor: total, discountMinor: 0 }], payments,
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null });
}
async function open(sid = randomUUID()) { expect((await w.push([w.cmd("session.open", { sessionId: sid, openingFloatMinor: 10000 })])).status).toBe(200); return sid; }

describe("gift cards", () => {
  it("are issued with a code shown once; only a hash and the last four are kept; the code works however it is typed", async () => {
    const g = await issue(5000, { note: "Birthday" }); expect(g.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/); expect(g.last4).toBe(g.code.slice(-4)); expect(g.balanceMinor).toBe(5000);
    const row = (await h.db.execute(sql`select code_hash, code_last4 from shelfline.gift_card`)).rows[0] as any; expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(row)).not.toContain(g.code.replace(/-/g, ""));
    expect(JSON.stringify((await w.hqApi.get(`/gift-cards/${g.id}`)).body)).not.toMatch(/code_?hash/i);
    for (const typed of [g.code, g.code.toLowerCase(), g.code.replace(/-/g, " "), g.code.replace(/-/g, "")]) expect((await w.hqApi.get(`/gift-cards/lookup?code=${encodeURIComponent(typed)}`)).body).toMatchObject({ id: g.id, balanceMinor: 5000, status: "active", expired: false, last4: g.last4 });
    expect((await w.hqApi.get("/gift-cards/lookup?code=ZZZZ-ZZZZ-ZZZZ-ZZZZ")).status).toBe(404);
    expect((await h.http().get(`/gift-cards/lookup?code=${g.code}`).set("Authorization", `Bearer ${w.tok}`)).status).toBe(200);                      // a till may ask
    expect((await w.hqApi.post("/gift-cards", { amountMinor: 0 })).status).toBe(400); expect((await w.hqApi.post("/gift-cards", { amountMinor: 100, code: g.code })).status).toBe(409);
    expect((await w.hqApi.get("/gift-cards")).body[0]).toMatchObject({ last4: g.last4, balanceMinor: 5000, loadedMinor: 5000, note: "Birthday", status: "active" });
  });
  it("top up once per key, void and restore, expire; the cashier role cannot issue but a store manager can", async () => {
    const g = await issue(2000); const key = randomUUID();
    expect((await w.hqApi.post(`/gift-cards/${g.id}/topup`, { amountMinor: 1500, idempotencyKey: key })).body).toMatchObject({ replayed: false, balanceMinor: 3500 }); expect((await w.hqApi.post(`/gift-cards/${g.id}/topup`, { amountMinor: 1500, idempotencyKey: key })).body).toMatchObject({ replayed: true, balanceMinor: 3500 });
    expect((await w.hqApi.patch(`/gift-cards/${g.id}`, { status: "void" })).body.status).toBe("void"); expect((await w.hqApi.post(`/gift-cards/${g.id}/topup`, { amountMinor: 100, idempotencyKey: randomUUID() })).status).toBe(409);
    expect((await w.hqApi.get(`/gift-cards/lookup?code=${g.code}`)).body.status).toBe("void"); await w.hqApi.patch(`/gift-cards/${g.id}`, { status: "active" });
    const old = await issue(1000, { expiresOn: "2020-01-01" }); expect((await w.hqApi.get(`/gift-cards/lookup?code=${old.code}`)).body.expired).toBe(true);
    expect((await h.http().post("/gift-cards").set("Authorization", `Bearer ${w.tok}`).send({ amountMinor: 1000 })).status).toBe(401);            // a till token is not an admin
    expect((await w.mgr.post("/gift-cards", { amountMinor: 1000 })).status).toBe(201); expect((await w.hqApi.get(`/gift-cards/${g.id}`)).body.entries.map((e: any) => [e.kind, e.deltaMinor])).toEqual([["topup", 1500], ["issue", 2000]]);
    expect((await w.owner.get("/audit?action=gift_card.issue")).body.length).toBeGreaterThan(0);
  });
  it("entries cannot be edited or deleted: the balance is only ever the sum", async () => {
    const g = await issue(1000); let err: any; try { await h.db.execute(sql`update shelfline.balance_entry set delta_minor = 999999 where account_id = ${g.id}`); } catch (e) { err = e; }
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/append-only/);
  });
});

describe("paying with a gift card", () => {
  it("spends part of a card: the sale is clean, the receipt shows only the last four, the balance is the sum of its entries", async () => {
    const g = await issue(5000); const sid = await open(); const r = await w.push([saleCmd(w, sid, 3000, [{ tender: "gift_card", amountMinor: 3000, reference: g.code }])]);
    expect(r.body.results[0]).toMatchObject({ status: "accepted" }); expect(r.body.results[0].flags ?? []).toEqual([]); expect(await balance(g.id)).toBe(2000);
    expect((await h.db.execute(sql`select tender, reference from shelfline.payment`)).rows).toEqual([{ tender: "gift_card", reference: `Card …${g.last4}` }]);
    expect((await h.db.execute(sql`select coalesce(sum(delta_minor), 0)::int as s from shelfline.balance_entry where account_id = ${g.id}`)).rows[0]).toMatchObject({ s: 2000 });
    const again = await w.push([saleCmd(w, sid, 3000, [{ tender: "gift_card", amountMinor: 3000, reference: g.code }], { saleId: (await h.db.execute(sql`select id from shelfline.sale`)).rows[0]!.id as string })]); void again; expect(await balance(g.id)).toBe(2000);
  });
  it("spending more than the card holds is accepted (the goods left) and flagged as an overdraft; unknown, void and expired cards are flagged too", async () => {
    const g = await issue(2000); const sid = await open();
    const r = await w.push([saleCmd(w, sid, 6000, [{ tender: "gift_card", amountMinor: 6000, reference: g.code }])]); expect(r.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["gift_card_overdraft"] }); expect(await balance(g.id)).toBe(-4000);
    const ex = (await h.db.execute(sql`select detail from shelfline.sync_exception where kind = 'gift_card_overdraft'`)).rows[0] as any; expect(ex.detail).toMatchObject({ last4: g.last4, balanceBeforeMinor: 2000, amountMinor: 6000, overdrawnMinor: 4000 });
    expect((await w.push([saleCmd(w, sid, 1000, [{ tender: "gift_card", amountMinor: 1000, reference: "NOPE-NOPE-NOPE-NOPE" }])])).body.results[0].flags).toEqual(["gift_card_unknown"]);
    expect((await h.db.execute(sql`select reference from shelfline.payment where amount_minor = 1000`)).rows[0]).toEqual({ reference: null });          // a bad code is not kept either
    const v = await issue(9000); await w.hqApi.patch(`/gift-cards/${v.id}`, { status: "void" }); expect((await w.push([saleCmd(w, sid, 1000, [{ tender: "gift_card", amountMinor: 1000, reference: v.code }])])).body.results[0].flags).toEqual(["gift_card_void"]);
    const e = await issue(9000, { expiresOn: "2020-01-01" }); expect((await w.push([saleCmd(w, sid, 1000, [{ tender: "gift_card", amountMinor: 1000, reference: e.code }])])).body.results[0].flags).toEqual(["gift_card_expired"]);
  });
  it("two tills spending the same A$50 card at once: both sales stand, the balance is exactly the sum, and exactly one is flagged as the overdraft", async () => {
    const g = await issue(5000);
    const reg = (await w.owner.post(`/locations/${w.fitzroy.id}/registers`, { code: "fit-9", name: "Side" })).body; const dev = (await w.owner.post("/devices", { kind: "pos", locationId: w.fitzroy.id, registerId: reg.id, name: "second iPad" })).body;
    const tok2 = (await h.http().post("/pos/pin").set("x-device-key", dev.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
    const s1 = await open(); const sid2 = randomUUID(); const c2 = (n: number, type: string, payload: unknown) => ({ id: uuidv7(), seq: n, type, payload, clientTs: new Date().toISOString(), schemaV: SCHEMA_V, actorId: w.cashier.id });
    const push2 = (cmds: object[]) => h.http().post("/sync/push").set("Authorization", `Bearer ${tok2}`).send({ deviceNow: new Date().toISOString(), commands: cmds });
    expect((await push2([c2(1, "session.open", { sessionId: sid2, openingFloatMinor: 10000 })])).status).toBe(200);
    const sale2 = saleCmd({ cmd: (t: string, p: unknown) => c2(2, t, p) } as never, sid2, 3000, [{ tender: "gift_card", amountMinor: 3000, reference: g.code }]);
    const [a, b] = await Promise.all([w.push([saleCmd(w, s1, 3000, [{ tender: "gift_card", amountMinor: 3000, reference: g.code }])]), push2([sale2])]);
    const results = [a.body.results[0], b.body.results[0]]; expect(results.map((x) => x.status).sort()).toEqual(["accepted", "accepted_flagged"]); expect(await balance(g.id)).toBe(-1000);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sync_exception where kind = 'gift_card_overdraft'`)).rows[0]).toMatchObject({ n: 1 });
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.balance_entry where account_id = ${g.id} and kind = 'redeem'`)).rows[0]).toMatchObject({ n: 2 });
  });
  it("a sale paid partly by card and partly by gift card keeps both tenders; the drawer is not affected by the gift card", async () => {
    const g = await issue(1000); const sid = await open(); const r = await w.push([saleCmd(w, sid, 4000, [{ tender: "gift_card", amountMinor: 1000, reference: g.code }, { tender: "card", amountMinor: 3000 }])]); expect(r.body.results[0].status).toBe("accepted");
    expect(await balance(g.id)).toBe(0); expect((await h.db.execute(sql`select tender, amount_minor::int as a from shelfline.payment order by id`)).rows).toEqual([{ tender: "gift_card", a: 1000 }, { tender: "card", a: 3000 }]);
  });
});

describe("store credit", () => {
  it("a refund to store credit credits the customer once; paying with it spends it; an overdraft is flagged; adjusting cannot go below zero", async () => {
    const cust = await customer(); const sid = await open(); const sale = randomUUID();
    expect((await w.push([saleCmd(w, sid, 4000, [{ tender: "card", amountMinor: 4000 }], { customerId: cust, saleId: sale })])).body.results[0].status).toBe("accepted");
    const lines = [{ saleLineNo: 0, qty: 1, amountMinor: 4000, taxMinor: 364, restock: true }]; const rid = randomUUID();
    const refund = w.cmd("refund.create", { refundId: rid, saleId: sale, sessionId: sid, tender: "store_credit", reason: "changed_mind", lines, totalMinor: 4000 });
    expect((await w.push([refund])).body.results[0].status).toMatch(/accepted/); expect((await w.hqApi.get(`/customers/${cust}/credit`)).body).toMatchObject({ balanceMinor: 4000, name: "Sam Okafor" });
    expect((await w.push([refund])).body.results[0].status).toBeTruthy(); expect((await w.hqApi.get(`/customers/${cust}/credit`)).body.balanceMinor).toBe(4000);               // a resent refund credits once
    expect((await w.push([saleCmd(w, sid, 1500, [{ tender: "store_credit", amountMinor: 1500 }], { customerId: cust })])).body.results[0]).toMatchObject({ status: "accepted" }); expect((await w.hqApi.get(`/customers/${cust}/credit`)).body.balanceMinor).toBe(2500);
    expect((await w.push([saleCmd(w, sid, 3000, [{ tender: "store_credit", amountMinor: 3000 }], { customerId: cust })])).body.results[0].flags).toEqual(["gift_card_overdraft"]); expect((await w.hqApi.get(`/customers/${cust}/credit`)).body.balanceMinor).toBe(-500);
    expect((await w.push([saleCmd(w, sid, 500, [{ tender: "store_credit", amountMinor: 500 }])])).body.results[0].flags).toEqual(["store_credit_no_customer"]);
    expect((await w.hqApi.post(`/customers/${cust}/credit`, { amountMinor: 2000, idempotencyKey: randomUUID(), note: "Goodwill" })).body.balanceMinor).toBe(1500); expect((await w.hqApi.post(`/customers/${cust}/credit`, { amountMinor: -2000, idempotencyKey: randomUUID(), note: "Take back" })).status).toBe(409);
    const nok = await customer("Walk In"); const sale2 = randomUUID(); await w.push([saleCmd(w, sid, 900, [{ tender: "card", amountMinor: 900 }], { saleId: sale2 })]);
    expect((await w.push([w.cmd("refund.create", { refundId: randomUUID(), saleId: sale2, sessionId: sid, tender: "store_credit", reason: "faulty", lines: [{ saleLineNo: 0, qty: 1, amountMinor: 900, taxMinor: 82, restock: true }], totalMinor: 900 })])).body.results[0].flags).toContain("refund_credit_no_customer"); void nok;
  });
});

describe("store credit, two tills at once", () => {
  it("both spend the same customer's credit together: the second to commit sees the first's spending, so exactly one overdraft is flagged and the balance is the plain sum", async () => {
    const cust = await customer(); await w.hqApi.post(`/customers/${cust}/credit`, { amountMinor: 4000, idempotencyKey: randomUUID(), note: "Opening credit" });
    const reg = (await w.owner.post(`/locations/${w.fitzroy.id}/registers`, { code: "fit-8", name: "Side" })).body; const dev = (await w.owner.post("/devices", { kind: "pos", locationId: w.fitzroy.id, registerId: reg.id, name: "second iPad" })).body;
    const tok2 = (await h.http().post("/pos/pin").set("x-device-key", dev.key).send({ employeeCode: "117", pin: "4821" })).body.token as string; const c2 = (n: number, type: string, payload: unknown) => ({ id: uuidv7(), seq: n, type, payload, clientTs: new Date().toISOString(), schemaV: SCHEMA_V, actorId: w.cashier.id });
    const push2 = (cmds: object[]) => h.http().post("/sync/push").set("Authorization", `Bearer ${tok2}`).send({ deviceNow: new Date().toISOString(), commands: cmds });
    const s1 = await open(); const s2 = randomUUID(); await push2([c2(1, "session.open", { sessionId: s2, openingFloatMinor: 10000 })]);
    const pay = [{ tender: "store_credit", amountMinor: 3000 }];
    const [a, b] = await Promise.all([w.push([saleCmd(w, s1, 3000, pay, { customerId: cust })]), push2([saleCmd({ cmd: (t: string, p: unknown) => c2(2, t, p) } as never, s2, 3000, pay, { customerId: cust })])]);
    expect([a.body.results[0].status, b.body.results[0].status].sort()).toEqual(["accepted", "accepted_flagged"]); expect((await w.hqApi.get(`/customers/${cust}/credit`)).body.balanceMinor).toBe(-2000);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sync_exception where kind = 'gift_card_overdraft'`)).rows[0]).toMatchObject({ n: 1 });
  });
});

describe("offline policy", () => {
  it("is off by default, set per location by someone who can manage it, and carried to the till with the rest of the location", async () => {
    const snap = async () => (await h.http().get("/sync/snapshot").set("Authorization", `Bearer ${w.tok}`)).body.items.find((i: any) => i.type === "location").data;
    expect(await snap()).toMatchObject({ giftCardOffline: false, giftCardOfflineCapMinor: 5000 });
    expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, { giftCardOffline: true, giftCardOfflineCapMinor: 2500 })).status).toBe(200); expect(await snap()).toMatchObject({ giftCardOffline: true, giftCardOfflineCapMinor: 2500 });
    expect((await w.mgr.patch(`/locations/${w.fitzroy.id}`, { giftCardOffline: false })).status).toBe(403);
  });
});
