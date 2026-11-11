import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); w = await posWorld(h, { stock: 50 }); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 20000 })]); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reader = async (o: object = {}) => { const r = await w.owner.post("/card-readers", { locationId: w.fitzroy.id, name: "Counter terminal", providerReaderId: "tmr_SIM1", ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string }; };
const tillPost = (path: string, b?: object) => h.http().post(path).set("Authorization", `Bearer ${w.tok}`).send(b ?? {});
const tillGet = (path: string) => h.http().get(path).set("Authorization", `Bearer ${w.tok}`);
const start = (amountMinor: number, key = randomUUID()) => tillPost("/pos/card/start", { amountMinor, idempotencyKey: key });
const settle = async (id: string, want: string, ms = 5000) => { const t = Date.now(); for (;;) { const r = await tillGet(`/pos/card/${id}`); if (r.body.status === want || Date.now() - t > ms) return r.body; await sleep(100); } };
async function sellOnCard(reference: string, amount = 21995) {
  const ls = [{ variantId: w.v[0]!.id, qty: 1, unitPriceMinor: 21995, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const sale = { saleId, sessionId: session, receiptNo: `C-${saleId.slice(0, 6)}`, customerId: null, lines: ls, payments: [{ tender: "card", amountMinor: amount, reference }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null };
  const r = await w.push([w.cmd("sale.create", sale)]); return { saleId, status: r.body.results[0].status as string, flags: (r.body.results[0].flags ?? []) as string[] };
}

describe("taking a card payment on the terminal", () => {
  it("is approved after the customer taps, gives a reference for the tender, and is tied to the sale when the sale arrives", async () => {
    await reader(); const a = await start(21995); expect(a.status).toBe(200); expect(a.body).toMatchObject({ status: "processing", amountMinor: 21995, provider: "simulated" });
    const done = await settle(a.body.id, "succeeded"); expect(done).toMatchObject({ status: "succeeded", brand: "visa", last4: "4242" }); expect(done.reference).toBe(`cp:${a.body.id} ····4242`);
    const s = await sellOnCard(done.reference); expect(s.status).toBe("accepted"); expect(s.flags).not.toContain("card_unverified");
    expect((await h.db.execute(sql`select sale_id from shelfline.card_payment where id = ${a.body.id}`)).rows[0]!.sale_id).toBe(s.saleId);
    expect((await w.owner.get("/card-payments")).body[0]).toMatchObject({ status: "succeeded", last4: "4242", saleId: s.saleId, reader: "Counter terminal" });
  });
  it("a decline is reported as a failure and nothing is left to add to a sale", async () => {
    await reader(); const a = await start(2013); expect(await settle(a.body.id, "failed")).toMatchObject({ status: "failed", failure: "card_declined" });
  });
  it("starting twice with the same key is one payment; a customer who walks away can be cancelled, a paid one cannot", async () => {
    await reader(); const key = randomUUID(); const a = await start(1077, key), b = await start(1077, key); expect(b.body.id).toBe(a.body.id); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.card_payment`)).rows[0]!.n).toBe(1);
    await sleep(400); expect((await tillGet(`/pos/card/${a.body.id}`)).body.status).toBe("processing");           // cents ending 77 never get tapped
    expect((await tillPost(`/pos/card/${a.body.id}/cancel`)).body.status).toBe("canceled"); expect((await tillPost(`/pos/card/${a.body.id}/cancel`)).body.status).toBe("canceled");
    const ok = await start(5000); await settle(ok.body.id, "succeeded"); expect((await tillPost(`/pos/card/${ok.body.id}/cancel`)).status).toBe(409);
    await expect(h.db.execute(sql`update shelfline.card_payment set status = 'processing' where id = ${ok.body.id}`)).rejects.toThrow(); await expect(h.db.execute(sql`update shelfline.card_payment set amount_minor = 1 where id = ${a.body.id}`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.card_payment`)).rejects.toThrow();
  });
  it("a payment nobody is standing at is called off after ten minutes", async () => {
    await reader(); const a = await start(3077); await h.db.execute(sql`alter table shelfline.card_payment disable trigger card_payment_guard`); await h.db.execute(sql`update shelfline.card_payment set created_at = now() - interval '11 minutes'`); await h.db.execute(sql`alter table shelfline.card_payment enable trigger card_payment_guard`);
    expect((await tillGet(`/pos/card/${a.body.id}`)).body).toMatchObject({ status: "failed", failure: "timed_out" });
  });
  it("says there is no terminal when none is set up, prefers the register's own, and ignores one that is switched off", async () => {
    expect((await start(1000)).body).toMatchObject({ code: "no_reader" });
    const shared = await reader({ name: "Shared", providerReaderId: "tmr_SHARED" }); const own = await reader({ name: "Own", providerReaderId: "tmr_OWN", registerId: w.register.id });
    await start(1000); expect((await h.db.execute(sql`select reader_id from shelfline.card_payment`)).rows[0]!.reader_id).toBe(own.id); await w.owner.patch(`/card-readers/${own.id}`, { active: false }); await start(1100); expect((await h.db.execute(sql`select reader_id from shelfline.card_payment order by created_at desc limit 1`)).rows[0]!.reader_id).toBe(shared.id);
  });
  it("a staff token is not a till, and bad requests are refused", async () => {
    await reader(); const a = await start(5000);
    expect((await h.http().get(`/pos/card/${a.body.id}`).set("Authorization", `Bearer ${w.ownerTok}`)).status).toBe(401); expect((await h.http().post("/pos/card/start").send({ amountMinor: 1, idempotencyKey: randomUUID() })).status).toBe(401);
    expect((await tillPost("/pos/card/start", { amountMinor: 0, idempotencyKey: randomUUID() })).status).toBe(400); expect((await tillPost("/pos/card/start", { amountMinor: 100, idempotencyKey: "nope" })).status).toBe(400); expect((await tillGet(`/pos/card/${randomUUID()}`)).status).toBe(404);
  });
});

describe("a sale that says it was paid on the terminal must have been", () => {
  it("is flagged when the payment was declined, was for another amount, was never made, or was already used for another sale", async () => {
    await reader(); const good = await start(21995); const g = await settle(good.body.id, "succeeded"); const decl = await start(2013); await settle(decl.body.id, "failed");
    expect((await sellOnCard(`cp:${decl.body.id}`)).flags).toContain("card_unverified");                              // declined
    expect((await sellOnCard(g.reference, 20000)).flags).toContain("card_unverified");                                  // approved for 219.95, claimed as 200.00
    expect((await sellOnCard(`cp:${randomUUID()}`)).flags).toContain("card_unverified");                                // no such payment
    const first = await sellOnCard(g.reference); expect(first.flags).not.toContain("card_unverified"); expect((await sellOnCard(g.reference)).flags).toContain("card_unverified");     // the second use of one approval
    const ex = (await w.owner.get(`/exceptions?locationId=${w.fitzroy.id}`)).body; expect(JSON.stringify(ex)).toContain("card_unverified");
    expect((await sellOnCard("Terminal receipt 0042")).flags).not.toContain("card_unverified");                         // a typed reference is the old manual way and is left alone
  });
});

describe("setting up terminals", () => {
  it("is for people who manage devices; names are unique per store; reader ids are plain identifiers", async () => {
    expect((await w.mgr.get("/card-readers")).status).toBe(403); expect((await w.mgr.post("/card-readers", { locationId: w.fitzroy.id, name: "x", providerReaderId: "tmr_1" })).status).toBe(403);
    await reader(); expect((await w.owner.post("/card-readers", { locationId: w.fitzroy.id, name: "Counter terminal", providerReaderId: "tmr_2" })).status).toBe(409);
    for (const bad of [{ providerReaderId: "tmr 1" }, { providerReaderId: "../x" }, { providerReaderId: "" }, { name: "" }]) expect((await w.owner.post("/card-readers", { locationId: w.fitzroy.id, name: "N", providerReaderId: "tmr_3", ...bad })).status).toBe(400);
    expect((await w.owner.get("/card-readers")).body[0]).toMatchObject({ name: "Counter terminal", provider: "simulated", location: "Fitzroy" }); expect((await w.owner.get("/audit?action=card_reader.create")).body).toHaveLength(1);
  });
});
