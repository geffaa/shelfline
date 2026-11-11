import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { SCHEMA_V, type Command } from "@shelfline/contracts";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { HttpTransport, MemoryStore, NetworkError, SyncEngine, type StatusResponse, type Transport } from "@shelfline/sync-client";
import type { PullResponse, PushRequest, PushResponse, SnapshotResponse } from "@shelfline/contracts";
import { LedgerService } from "../src/inventory/ledger.service";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

/**
 * Soak: many tills, thousands of real sale/refund/cash/punch commands, a network that drops requests and answers, and then proof:
 *  1. every command took effect exactly once and the end state equals a straightforward model;
 *  2. wiping the transactional tables and replaying the same commands in a DIFFERENT interleaving across tills gives the identical ledger and cash.
 * Defaults are the milestone's numbers (10 tills x 500 sales). SOAK_CLIENTS / SOAK_SALES shrink it for quick runs.
 */
const CLIENTS = Number(process.env.SOAK_CLIENTS ?? 10), SALES = Number(process.env.SOAK_SALES ?? 500);
const rngFrom = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

class Flaky implements Transport {
  enabled = true;
  constructor(private inner: Transport, private rng: () => number, private p = { before: 0.1, after: 0.1, dup: 0.05 }) {}
  private async wrap<T>(call: () => Promise<T>): Promise<T> {
    if (this.enabled && this.rng() < this.p.before) throw new NetworkError("lost before");
    let out: T;
    if (this.enabled && this.rng() < this.p.dup) { const [a, b] = await Promise.allSettled([call(), call()]); const ok = a.status === "fulfilled" ? a : b; if (ok.status !== "fulfilled") throw (ok as PromiseRejectedResult).reason; out = ok.value; } else out = await call();
    if (this.enabled && this.rng() < this.p.after) throw new NetworkError("response lost");
    return out;
  }
  push(r: PushRequest): Promise<PushResponse> { return this.wrap(() => this.inner.push(r)); }
  pull(c: string, l?: number): Promise<PullResponse> { return this.wrap(() => this.inner.pull(c, l)); }
  snapshot(a: string | null): Promise<SnapshotResponse> { return this.wrap(() => this.inner.snapshot(a)); }
  status(): Promise<StatusResponse> { return this.wrap(() => this.inner.status()); }
}

let h: Harness;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });

describe(`soak: ${CLIENTS} tills x ${SALES} sales`, () => {
  it("every command lands exactly once, the end state equals the model, and a replay in another order reproduces it byte for byte", async () => {
    await reset(h);
    const c = await catalogWorld(h); const ledger = h.app.get(LedgerService);
    await h.app.listen(0, "127.0.0.1"); const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");

    // ---- catalogue: 30 variants, 27 well stocked and 3 scarce (so some sales legitimately go negative)
    const prods = [] as { id: string; price: number; scarce: boolean }[]; const receives: { locationId: string; idempotencyKey: string; lines: { variantId: string; qty: number; unitCostMinor: number }[] }[] = [];
    const initial = new Map<string, number>();
    for (let p = 0; p < 10; p++) {
      const prod = (await c.hqApi.post("/products", { title: `Soak shoe ${p}`, taxClassId: c.gst.id, variants: [0, 1, 2].map((v) => ({ sku: `SK-${p}-${v}`, basePriceMinor: 5000 + p * 1300 + v * 700 })) })).body;
      for (const [i, v] of prod.variants.entries()) prods.push({ id: v.id, price: v.basePriceMinor, scarce: p === 0 && i < 3 });
    }
    for (const v of prods) { const qty = v.scarce ? 40 : 100_000; initial.set(v.id, qty); receives.push({ locationId: c.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: v.id, qty, unitCostMinor: Math.round(v.price * 0.55) }] }); }
    for (const r of receives) expect((await c.hqApi.post("/inventory/receive", r)).status).toBe(200);

    // ---- tills: one register and one POS device each
    const tills = await Promise.all(Array.from({ length: CLIENTS }, async (_, i) => {
      const reg = (await c.owner.post(`/locations/${c.fitzroy.id}/registers`, { code: `SK-${i}`, name: `Soak ${i}` })).body;
      const dev = (await c.owner.post("/devices", { kind: "pos", locationId: c.fitzroy.id, registerId: reg.id, name: `soak ${i}` })).body;
      const tok = (await h.http().post("/pos/pin").set("x-device-key", dev.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
      return { i, regId: reg.id as string, devId: dev.id as string, tok };
    }));

    // ---- generate each till's whole day up front, with a model of what the server must end up with
    const stockDelta = new Map<string, number>(); const bump = (v: string, d: number) => stockDelta.set(v, (stockDelta.get(v) ?? 0) + d);
    const model = new Map<string, { expected: number; sales: number; refunds: number; net: number; punches: number }>();
    const stores = tills.map((t) => ({ ...t, store: new MemoryStore(), sessionId: randomUUID(), rng: rngFrom(7000 + t.i), cmds: 0 }));
    const T0 = Date.parse(new Date().toISOString().slice(0, 10) + "T00:30:00Z");       // all inside one business day
    for (const t of stores) {
      let clock = T0 + t.i * 1000; const tick = () => (clock += 20_000 + Math.floor(t.rng() * 20_000));
      const enq = (type: string, payload: unknown) => t.store.transact((tx) => tx.enqueue({ type, payload, actorId: c.cashier.id, schemaV: SCHEMA_V, clientTs: new Date(tick()).toISOString() }));
      const float = 10_000 + Math.floor(t.rng() * 40_000); let cash = float; let sales = 0, refunds = 0, punches = 0; const open: { saleId: string; tender: "cash" | "card"; lines: { qty: number; unitPriceMinor: number; variantId: string }[]; total: number; tax: number }[] = [];
      await enq("session.open", { sessionId: t.sessionId, openingFloatMinor: float });
      await enq("punch.record", { punchId: randomUUID(), kind: "in", method: "pin" }); punches++;
      for (let n = 0; n < SALES; n++) {
        const roll = t.rng();
        if (roll < 0.06 && open.length) {                                                         // cash/card refund of a whole earlier sale
          const s = open.splice(Math.floor(t.rng() * open.length), 1)[0]!;
          const lines = s.lines.map((l, i) => { const tax = priceCart([{ ...l, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } }]).taxMinor; return { saleLineNo: i, qty: l.qty, ...refundAmount({ qty: l.qty, refundedQty: 0, totalMinor: l.qty * l.unitPriceMinor, refundedMinor: 0, taxMinor: tax, refundedTaxMinor: 0 }, l.qty), restock: true }; });
          const total = lines.reduce((a, l) => a + l.amountMinor, 0);
          await enq("refund.create", { refundId: randomUUID(), saleId: s.saleId, sessionId: t.sessionId, tender: s.tender, reason: "faulty", lines, totalMinor: total });
          refunds += total; if (s.tender === "cash") cash -= total; for (const l of s.lines) bump(l.variantId, l.qty);
        } else if (roll < 0.11) {                                                                  // drawer movement
          const kind = (["pay_in", "pay_out", "drop"] as const)[Math.floor(t.rng() * 3)]!; const amt = 500 + Math.floor(t.rng() * 20_000);
          await enq("cash.move", { movementId: randomUUID(), sessionId: t.sessionId, kind, amountMinor: amt, reason: "soak" }); cash += kind === "pay_in" ? amt : -amt;
        } else if (roll < 0.12) { await enq("punch.record", { punchId: randomUUID(), kind: punches % 2 === 0 ? "in" : "out", method: "pin" }); punches++; }
        else {                                                                                     // a sale
          const ls = Array.from({ length: 1 + Math.floor(t.rng() * 3) }, () => { const v = prods[Math.floor(t.rng() * prods.length)]!; return { variantId: v.id, qty: 1 + Math.floor(t.rng() * 3), unitPriceMinor: v.price }; });
          const merged = [...new Map(ls.map((l) => [l.variantId, l])).values()];
          const priced = priceCart(merged.map((l) => ({ ...l, discountMinor: 0, tax: { rateBp: 1000, inclusive: true } })));
          const tender = t.rng() < 0.4 ? "cash" : "card"; const saleId = randomUUID();
          await enq("sale.create", { saleId, sessionId: t.sessionId, receiptNo: `SK-${t.i}-${String(n).padStart(6, "0")}`, customerId: null, lines: merged.map((l) => ({ ...l, discountMinor: 0 })), payments: [{ tender, amountMinor: priced.payableMinor, ...(tender === "cash" ? { tenderedMinor: priced.payableMinor } : {}) }],
            totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null });
          sales += priced.totalMinor; if (tender === "cash") cash += priced.payableMinor; for (const l of merged) bump(l.variantId, -l.qty);
          open.push({ saleId, tender, lines: merged, total: priced.totalMinor, tax: priced.taxMinor });
        }
      }
      await enq("session.close", { sessionId: t.sessionId, countedMinor: Math.max(0, cash) });
      model.set(t.sessionId, { expected: cash, sales, refunds, net: sales - refunds, punches });
    }
    const sent = new Map<number, Command[]>(); for (const t of stores) sent.set(t.i, await t.store.pendingCommands(1_000_000));
    const total = [...sent.values()].reduce((a, l) => a + l.length, 0);

    // ---- run: every till syncs through a network that loses requests and answers
    const engines = stores.map((t) => { const flaky = new Flaky(new HttpTransport(base, () => t.tok), rngFrom(9100 + t.i)); return { t, flaky, engine: new SyncEngine(t.store, flaky, () => new Date(), 50) }; });
    const t0 = Date.now();
    await Promise.all(engines.map(async ({ t, flaky, engine }) => { for (let a = 0; a < 2000; a++) { if (a === 400) flaky.enabled = false; await engine.pushAll().catch(() => undefined); if ((await t.store.pendingCount()) === 0) break; } }));
    const secs = (Date.now() - t0) / 1000;
    for (const { t } of engines) expect(await t.store.pendingCount(), `till ${t.i} queue`).toBe(0);

    // ---- 1. exactly once, and equal to the model
    const q1 = async (query: ReturnType<typeof sql>) => (await h.db.execute(query)).rows as Record<string, any>[];
    expect(Number((await q1(sql`select count(*)::int as n from shelfline.sync_command_receipt`))[0]!.n)).toBe(total);
    const st = await q1(sql`select status, count(*)::int as n from shelfline.sync_command_receipt group by 1`);
    expect(st.filter((r) => r.status === "rejected")).toEqual([]);
    for (const x of tills) expect(Number((await q1(sql`select last_seq from shelfline.device where id = ${x.devId}`))[0]!.last_seq), `till ${x.i} sequence`).toBe(sent.get(x.i)!.length);
    expect(await ledger.check(c.orgId)).toEqual([]);
    for (const v of prods) { const [r] = await q1(sql`select on_hand from shelfline.stock_balance where variant_id = ${v.id} and location_id = ${c.fitzroy.id}`); expect(Number(r!.on_hand), `stock ${v.id}`).toBe(initial.get(v.id)! + (stockDelta.get(v.id) ?? 0)); }
    for (const [sid, m] of model) {
      const [s] = await q1(sql`select status, expected_close_minor, counted_close_minor, variance_minor, flags from shelfline.register_session where id = ${sid}`);
      expect(s, `session ${sid}`).toMatchObject({ status: "closed", expected_close_minor: m.expected, variance_minor: Math.max(0, m.expected) - m.expected });
      const [z] = await q1(sql`select coalesce(sum(total_minor), 0)::int as sales from shelfline.sale where session_id = ${sid}`); expect(Number(z!.sales)).toBe(m.sales);
      const [r] = await q1(sql`select coalesce(sum(total_minor), 0)::int as refunds from shelfline.refund where session_id = ${sid}`); expect(Number(r!.refunds)).toBe(m.refunds);
      const [pn] = await q1(sql`select count(*)::int as n from shelfline.punch p join shelfline.register_session s on s.id = ${sid} where p.source_device_id = (select id from shelfline.device where register_id = s.register_id limit 1)`); expect(Number(pn!.n)).toBe(m.punches);
    }

    // ---- 2. wipe the transactional tables and replay the same commands in a different interleaving
    const checksum = async () => {
      const h256 = (rows: Record<string, unknown>[]) => createHash("sha256").update(rows.map((r) => Object.values(r).join("|")).join("\n")).digest("hex");
      const ledgerRows = await q1(sql`select variant_id, location_id, kind, source_type, source_id, line_no, qty_delta from shelfline.stock_movement order by variant_id, location_id, kind, source_type, source_id, line_no`);
      const balances = await q1(sql`select variant_id, location_id, on_hand from shelfline.stock_balance order by variant_id, location_id`);
      const sessions = await q1(sql`select id, status, opening_float_minor, expected_close_minor, counted_close_minor, variance_minor from shelfline.register_session order by id`);
      const sales = await q1(sql`select id, receipt_no, total_minor, tax_minor, discount_minor, status from shelfline.sale order by id`);
      const lines = await q1(sql`select sale_id, line_no, qty, total_minor, tax_minor, refunded_qty, refunded_minor, refunded_tax_minor from shelfline.sale_line order by sale_id, line_no`);
      const pays = await q1(sql`select sale_id, tender, amount_minor from shelfline.payment order by sale_id, tender, amount_minor`);
      const refunds = await q1(sql`select id, sale_id, tender, total_minor, tax_minor from shelfline.refund order by id`);
      const moves = await q1(sql`select id, kind, amount_minor from shelfline.cash_movement order by id`);
      return { ledger: h256(ledgerRows), balances: h256(balances), sessions: h256(sessions), sales: h256(sales), lines: h256(lines), pays: h256(pays), refunds: h256(refunds), moves: h256(moves), counts: { ledger: ledgerRows.length, sales: sales.length, refunds: refunds.length, moves: moves.length } };
    };
    const before = await checksum();
    await h.db.execute(sql`truncate table shelfline.stock_movement, shelfline.stock_balance, shelfline.refund_line, shelfline.refund, shelfline.payment, shelfline.sale_line, shelfline.sale, shelfline.cash_movement, shelfline.register_session, shelfline.punch, shelfline.sync_command_receipt, shelfline.sync_exception, shelfline.change_log restart identity cascade`);
    await h.db.execute(sql`update shelfline.device set last_seq = 0`);
    for (const r of receives) expect((await c.hqApi.post("/inventory/receive", r)).status).toBe(200);          // the opening stock, same idempotency keys
    expect((await checksum()).counts.sales).toBe(0);
    const pos = new Map(tills.map((x) => [x.i, 0])); const rng = rngFrom(424242);                              // a different schedule: random till, random batch size
    const remaining = () => tills.filter((x) => pos.get(x.i)! < sent.get(x.i)!.length);
    while (remaining().length) {
      const x = remaining()[Math.floor(rng() * remaining().length)]!; const list = sent.get(x.i)!; const from = pos.get(x.i)!; const n = 1 + Math.floor(rng() * 40);
      const r = await h.http().post("/sync/push").set("Authorization", `Bearer ${x.tok}`).send({ deviceNow: new Date().toISOString(), commands: list.slice(from, from + n) });
      expect(r.status).toBe(200); expect(r.body.results.every((y: { status: string }) => y.status !== "rejected" && y.status !== "gap")).toBe(true); pos.set(x.i, from + n);
    }
    const after = await checksum();
    expect(after).toEqual(before);
    expect(await ledger.check(c.orgId)).toEqual([]);
    console.log(`soak: ${CLIENTS} tills, ${total} commands (${before.counts.sales} sales, ${before.counts.refunds} refunds, ${before.counts.moves} cash entries) in ${secs.toFixed(1)}s over a lossy network; replay in a different order gave identical checksums (ledger ${before.ledger.slice(0, 12)}, cash ${before.sessions.slice(0, 12)})`);
  }, 1_200_000);
});
