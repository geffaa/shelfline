import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { PullResponse, PushRequest, PushResponse, SnapshotResponse } from "@shelfline/contracts";
import { SCHEMA_V } from "@shelfline/contracts";
import { HttpTransport, MemoryStore, NetworkError, SyncEngine, type StatusResponse, type Transport } from "@shelfline/sync-client";
import { CommandRegistry } from "../src/sync/commands";
import { LedgerService } from "../src/inventory/ledger.service";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

const SCENARIOS = Number(process.env.SYNC_SCENARIOS ?? 200);
const CLIENTS = 10;

function rngFrom(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Flaky network: requests can be lost before reaching the server, answered but the answer lost, or sent twice at once. */
class FaultyTransport implements Transport {
  enabled = true;
  constructor(private inner: Transport, private rng: () => number, private p = { before: 0.15, after: 0.15, dup: 0.1 }) {}
  private async wrap<T>(call: () => Promise<T>): Promise<T> {
    if (this.enabled && this.rng() < this.p.before) throw new NetworkError("lost before reaching the server");
    let out: T;
    if (this.enabled && this.rng() < this.p.dup) { const [a, b] = await Promise.allSettled([call(), call()]); const ok = a.status === "fulfilled" ? a : b; if (ok.status !== "fulfilled") throw (ok as PromiseRejectedResult).reason; out = ok.value; }
    else out = await call();
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

describe(`sync model: ${SCENARIOS} random scenarios, ${CLIENTS} clients, flaky network, skewed clocks, concurrent HQ edits`, () => {
  it("every command takes effect exactly once and the end state equals serial execution; every replica converges", async () => {
    await reset(h);
    const c = await catalogWorld(h);
    const ledger = h.app.get(LedgerService);
    // Test-only physical-fact command: like a sale it may drive stock negative (flagged). Commutative, so any arrival order gives the serial result.
    h.app.get(CommandRegistry).register({
      type: "test.sale", schema: z.object({ variantId: z.string().uuid(), qty: z.number().int().min(1).max(5) }),
      handle: async (ctx, p) => {
        const r = await ledger.appendIn(ctx.tx, ctx.orgId, ctx.actorId, [{ variantId: p.variantId, locationId: ctx.device.locationId, qtyDelta: -p.qty, kind: "sale", sourceType: "test.sale", sourceId: ctx.commandId, allowNegative: true, at: ctx.at }]);
        return { result: { applied: r.applied }, flags: r.negative.length ? ["negative_stock"] : [] };
      },
    });
    await h.app.listen(0, "127.0.0.1");
    const base = (await h.app.getUrl()).replace("[::1]", "127.0.0.1");

    const prod = (await c.hqApi.post("/products", { title: "Tempra Glide 3", taxClassId: c.gst.id, variants: ["A", "B", "C", "D", "E", "F"].map((s, i) => ({ sku: `TG3-${s}`, basePriceMinor: 20000 + i })) })).body;
    const vids: string[] = prod.variants.map((v: { id: string }) => v.id);
    const expected = new Map<string, number>(vids.map((v) => [v, 0]));
    const addStock = async (vid: string, qty: number) => { await c.hqApi.post("/inventory/receive", { locationId: c.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: vid, qty, unitCostMinor: 100 }] }); expected.set(vid, expected.get(vid)! + qty); };
    for (const v of vids) await addStock(v, 8);

    const skewMs = [600_000, -600_000, 45_000, 0, 0, 0, 0, 0, 0, 0];
    const clients = await Promise.all(Array.from({ length: CLIENTS }, async (_, i) => {
      const dev = (await c.owner.post("/devices", { kind: "pos", locationId: c.fitzroy.id, registerId: c.register.id, name: `iPad ${i}` })).body;
      const tok = (await h.http().post("/pos/pin").set("x-device-key", dev.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
      const now = () => new Date(Date.now() + skewMs[i]!);
      const store = new MemoryStore(() => now().getTime());
      const rng = rngFrom(9000 + i);
      const faulty = new FaultyTransport(new HttpTransport(base, () => tok), rng);
      return { i, dev, tok, store, faulty, engine: new SyncEngine(store, faulty, now, 20), made: [] as { id: string; seq: number; kind: "sale" | "unknown" | "invalid"; vid?: string; qty?: number }[], rejectedExpected: 0 };
    }));
    // Everyone downloads the snapshot through the flaky network before the first scenario.
    for (const cl of clients) { for (let t = 0; t < 40 && !(await cl.engine.syncOnce().catch(() => false)); t++); }

    const checkConvergence = async (cl: (typeof clients)[number]) => {
      cl.faulty.enabled = false; await cl.engine.pushAll(); await cl.engine.pullAll(); cl.faulty.enabled = true;
      const dbVariants = (await h.db.execute(sql`select id, sku, base_price_minor, status from shelfline.variant order by id`)).rows as { id: string; sku: string; base_price_minor: number; status: string }[];
      const local = new Map((await cl.store.list<{ sku: string; basePriceMinor: number; status: string }>("replica:variant")).map((e) => [e.key, e.value]));
      expect(local.size).toBe(dbVariants.length);
      for (const v of dbVariants) expect(local.get(v.id), `client ${cl.i} variant ${v.sku}`).toMatchObject({ sku: v.sku, basePriceMinor: v.base_price_minor, status: v.status });
      const bal = (await h.db.execute(sql`select variant_id, on_hand from shelfline.stock_balance where location_id = ${c.fitzroy.id}`)).rows as { variant_id: string; on_hand: number }[];
      const lb = new Map((await cl.store.list<{ onHand: number }>("replica:stock_balance")).map((e) => [e.key, e.value.onHand]));
      expect(lb.size, `client ${cl.i} stock rows`).toBe(bal.length);
      for (const b of bal) expect(lb.get(`${b.variant_id}:${c.fitzroy.id}`), `client ${cl.i} stock`).toBe(b.on_hand);
    };

    let totalCommands = 0, totalFlagged = 0, totalRejected = 0;
    for (let s = 0; s < SCENARIOS; s++) {
      const seed = 100_000 + s; const rng = rngFrom(seed);
      const tag = `scenario ${s} (seed ${seed})`;
      const scenarioIds = new Map<string, (typeof clients)[number]["made"][number]>();
      const perClient = new Map<number, string[]>();

      const hq = (async () => {
        for (let k = Math.floor(rng() * 3); k > 0; k--) await c.hqApi.patch(`/variants/${vids[Math.floor(rng() * vids.length)]}`, { basePriceMinor: 15000 + Math.floor(rng() * 9000) });
        for (let k = Math.floor(rng() * 3); k > 0; k--) await addStock(vids[Math.floor(rng() * vids.length)]!, 1 + Math.floor(rng() * 6));
      })();

      await Promise.all([hq, ...clients.map(async (cl) => {
        const crng = rngFrom(seed * 31 + cl.i);
        cl.faulty.enabled = true; const ids: string[] = []; perClient.set(cl.i, ids);
        for (let k = Math.floor(crng() * 7); k > 0; k--) {
          const roll = crng(); const kind = roll < 0.75 ? "sale" : roll < 0.87 ? "unknown" : "invalid";
          const vid = vids[Math.floor(crng() * vids.length)]!; const qty = 1 + Math.floor(crng() * 5);
          const payload = kind === "sale" ? { variantId: vid, qty } : kind === "invalid" ? { variantId: "nope", qty: 0 } : {};
          const type = kind === "unknown" ? "sale.teleport" : "test.sale";
          const cmd = await cl.store.transact((tx) => tx.enqueue({ type, payload, actorId: c.cashier.id, schemaV: SCHEMA_V }));
          const rec = { id: cmd.id, seq: cmd.seq, kind: kind as "sale" | "unknown" | "invalid", vid: kind === "sale" ? vid : undefined, qty: kind === "sale" ? qty : undefined };
          cl.made.push(rec); scenarioIds.set(cmd.id, rec); ids.push(cmd.id);
          if (crng() < 0.3) await cl.engine.syncOnce().catch(() => false);      // sometimes the cashier is online mid-shift
        }
        for (let t = 0; t < 120; t++) {
          if (t === 40) cl.faulty.enabled = false;                               // guarantee termination
          const ok = await cl.engine.syncOnce().catch(() => false);
          if (ok && (await cl.store.pendingCount()) === 0) break;
        }
      })]);

      // ---- assertions for this scenario
      const ids = [...scenarioIds.keys()]; totalCommands += ids.length;
      for (const rec of scenarioIds.values()) if (rec.kind === "sale") expected.set(rec.vid!, expected.get(rec.vid!)! - rec.qty!);
      for (const cl of clients) expect(await cl.store.pendingCount(), `${tag}: client ${cl.i} outbox`).toBe(0);
      if (ids.length) {
        const receipts = (await h.db.execute(sql`select command_id, status, reason, flags from shelfline.sync_command_receipt where command_id = any(${sql.raw(`ARRAY[${ids.map((x) => `'${x}'::uuid`).join(",")}]`)})`)).rows as { command_id: string; status: string; reason: string | null; flags: string[] }[];
        expect(receipts.length, `${tag}: one receipt per command`).toBe(ids.length);
        for (const r of receipts) {
          const rec = scenarioIds.get(r.command_id)!;
          if (rec.kind === "sale") expect(["accepted", "accepted_flagged"], `${tag}: sale ${r.command_id}`).toContain(r.status);
          else { expect(r.status, `${tag}: ${rec.kind}`).toBe("rejected"); expect(r.reason).toBe(rec.kind === "unknown" ? "unknown_command" : "invalid_payload"); totalRejected++; }
          if (r.status === "accepted_flagged") totalFlagged++;
        }
        const moves = (await h.db.execute(sql`select source_id, count(*)::int as n from shelfline.stock_movement where source_type = 'test.sale' and source_id = any(${sql.raw(`ARRAY[${ids.map((x) => `'${x}'`).join(",")}]::text[]`)}) group by 1`)).rows as { source_id: string; n: number }[];
        const sales = [...scenarioIds.values()].filter((x) => x.kind === "sale");
        expect(moves.length, `${tag}: a movement per valid sale`).toBe(sales.length);
        expect(moves.every((m) => m.n === 1), `${tag}: never twice`).toBe(true);
        const skewedCmds = [0, 1].flatMap((i) => perClient.get(i) ?? []);
        const skewEx = (await h.db.execute(sql`select count(*)::int as n from shelfline.sync_exception where kind = 'skewed_clock' and command_id = any(${sql.raw(`ARRAY[${ids.map((x) => `'${x}'::uuid`).join(",")}]`)})`)).rows[0] as { n: number };
        expect(skewEx.n, `${tag}: skewed clocks are flagged, and only those`).toBe(skewedCmds.length);
      }
      for (const cl of clients) {
        const [d] = (await h.db.execute(sql`select last_seq from shelfline.device where id = ${cl.dev.id}`)).rows as { last_seq: string }[];
        expect(Number(d!.last_seq), `${tag}: client ${cl.i} sequence`).toBe((await cl.store.nextSeq()) - 1);
      }
      const bal = (await h.db.execute(sql`select variant_id, on_hand from shelfline.stock_balance where location_id = ${c.fitzroy.id}`)).rows as { variant_id: string; on_hand: number }[];
      for (const b of bal) expect(b.on_hand, `${tag}: stock of ${b.variant_id} equals serial execution`).toBe(expected.get(b.variant_id));
      expect(await ledger.check(c.orgId), `${tag}: ledger invariant`).toEqual([]);
      if (s % 20 === 19) for (const cl of clients) await checkConvergence(cl); else await checkConvergence(clients[s % CLIENTS]!);
    }
    for (const cl of clients) await checkConvergence(cl);
    // Client-side records agree with the server: rejected commands are kept for the Sync screen, flagged ones too.
    const clientRejections = (await Promise.all(clients.map((cl) => cl.store.rejections()))).flat().length;
    expect(clientRejections).toBe(totalRejected);
    const clientFlagged = (await Promise.all(clients.map((cl) => cl.store.flagged()))).flat().length;
    expect(clientFlagged).toBeGreaterThanOrEqual(totalFlagged - totalRejected * 0); // flagged sales (and skew-flagged rejections are recorded as rejections)
    console.log(`sync model: ${SCENARIOS} scenarios, ${totalCommands} commands, ${totalRejected} rejected, ${totalFlagged} flagged; all applied exactly once`);
  }, 900_000);
});
