import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { LedgerService } from "../src/inventory/ledger.service";
import { CountsService } from "../src/stockops/counts.service";
import { TransfersService } from "../src/stockops/transfers.service";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let c: Awaited<ReturnType<typeof catalogWorld>>; let dc: { id: string }; let vs: { id: string; sku: string }[];
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); c = await catalogWorld(h);
  dc = (await c.owner.post("/locations", { code: "dnd", name: "Dandenong DC", type: "warehouse", timezone: "Australia/Melbourne" })).body;
  vs = (await c.hqApi.post("/products", { title: "Tempra Glide 5", categoryId: c.shoes.id, taxClassId: c.gst.id, variants: [{ sku: "TX-A", basePriceMinor: 21995 }, { sku: "TX-B", basePriceMinor: 8900 }, { sku: "TX-C", basePriceMinor: 3400 }] })).body.variants;
});
const stock = async (loc: string, variantId = vs[0]!.id) => Number(((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${variantId} and location_id = ${loc}`)).rows[0] as any)?.on_hand ?? 0);
const avg = async (loc: string, variantId = vs[0]!.id) => ((await h.db.execute(sql`select avg_cost_minor from shelfline.stock_balance where variant_id = ${variantId} and location_id = ${loc}`)).rows[0] as any)?.avg_cost_minor;
const total = async (variantId = vs[0]!.id) => Number(((await h.db.execute(sql`select coalesce(sum(on_hand), 0)::int as t from shelfline.stock_balance where variant_id = ${variantId}`)).rows[0] as any).t);
const receive = (loc: string, qty: number, cost = 5000, variantId = vs[0]!.id) => c.hqApi.post("/inventory/receive", { locationId: loc, idempotencyKey: randomUUID(), lines: [{ variantId, qty, unitCostMinor: cost }] });
const sell = (loc: string, qty: number, variantId = vs[0]!.id) => h.app.get(LedgerService).append(c.orgId, c.hq.id, [{ variantId, locationId: loc, qtyDelta: -qty, kind: "sale", sourceType: "sale", sourceId: randomUUID(), allowNegative: true }]);
const xfer = async (from: string, to: string, qty: number, api = c.hqApi, variantId = vs[0]!.id) => api.post("/transfers", { fromLocationId: from, toLocationId: to, lines: [{ variantId, qty }] });
const lineOf = async (id: string) => (await c.hqApi.get(`/transfers/${id}`)).body.lines[0] as { id: string };
const recv = (id: string, lineId: string, qty: number, extra: object = {}, api = c.hqApi) => api.post(`/transfers/${id}/receive`, { idempotencyKey: randomUUID(), lines: [{ lineId, qty }], ...extra });
const transitOf = async (id: string) => (await c.hqApi.get(`/transfers/${id}`)).body.transitLocationId as string;

describe("transfers", () => {
  it("12 sent and 11 received: source -12, destination +11, transit back to zero, one shortage of 1, and the total across every location is down by exactly that 1", async () => {
    await receive(dc.id, 50); const before = await total();
    const t = (await xfer(dc.id, c.fitzroy.id, 12)).body; expect(t).toMatchObject({ status: "draft" }); expect(t.number).toMatch(/^TR-\d{6}$/);
    expect(await stock(dc.id)).toBe(50); expect((await c.hqApi.post(`/transfers/${t.id}/send`)).body.status).toBe("sent");
    const tr = await transitOf(t.id); expect(await stock(dc.id)).toBe(38); expect(await stock(tr)).toBe(12); expect(await total()).toBe(before);   // nothing lost while it is on the road
    const l = await lineOf(t.id); expect((await recv(t.id, l.id, 11, { closeShort: true })).body).toMatchObject({ status: "received", variance: 1 });
    expect(await stock(c.fitzroy.id)).toBe(11); expect(await stock(tr)).toBe(0); expect(await total()).toBe(before - 1);
    const mv = (await h.db.execute(sql`select kind, qty_delta::int as q, location_id from shelfline.stock_movement where kind = 'transfer_variance'`)).rows as any[]; expect(mv).toEqual([{ kind: "transfer_variance", q: -1, location_id: tr }]);
    expect(await h.app.get(LedgerService).check(c.orgId)).toEqual([]);
    expect((await c.hqApi.get(`/transfers/${t.id}`)).body).toMatchObject({ status: "received", lines: [{ qtySent: 12, qtyReceived: 11, qtyVariance: 1 }] });
  });
  it("can be received in parts; over-receiving and receiving twice with one key are handled; stock cannot leave a place that does not have it", async () => {
    await receive(dc.id, 20); const t = (await xfer(dc.id, c.fitzroy.id, 10)).body; const l = await lineOf(t.id);
    expect((await recv(t.id, l.id, 3)).status).toBe(409);                                                            // not sent yet
    await c.hqApi.post(`/transfers/${t.id}/send`); expect((await c.hqApi.post(`/transfers/${t.id}/send`)).status).toBe(409);
    const key = randomUUID(); const body = { idempotencyKey: key, lines: [{ lineId: l.id, qty: 4 }] };
    expect((await c.hqApi.post(`/transfers/${t.id}/receive`, body)).body).toMatchObject({ replayed: false, status: "partial" }); expect((await c.hqApi.post(`/transfers/${t.id}/receive`, body)).body).toMatchObject({ replayed: true });
    expect(await stock(c.fitzroy.id)).toBe(4); expect((await recv(t.id, l.id, 7)).body).toMatchObject({ code: "over_receipt", open: 6 });
    expect((await recv(t.id, l.id, 6)).body).toMatchObject({ status: "received", variance: 0 }); expect(await stock(c.fitzroy.id)).toBe(10); expect(await stock(await transitOf(t.id))).toBe(0);
    const short = (await xfer(dc.id, c.southYarra.id, 11)).body; const r = await c.hqApi.post(`/transfers/${short.id}/send`); expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: "insufficient_stock", onHand: 10 });
    expect(await stock(dc.id)).toBe(10); expect(Number(((await h.db.execute(sql`select count(*)::int as n from shelfline.location where type = 'transit'`)).rows[0] as any).n)).toBe(1);   // the refused send left no transit place behind
    expect((await xfer(dc.id, dc.id, 1)).status).toBe(400);
  });
  it("a shipment that never arrives is closed short with nothing received: the whole quantity becomes a recorded shortage", async () => {
    await receive(dc.id, 30); const t = (await xfer(dc.id, c.fitzroy.id, 8)).body; await c.hqApi.post(`/transfers/${t.id}/send`);
    expect((await c.hqApi.post(`/transfers/${t.id}/receive`, { idempotencyKey: randomUUID(), closeShort: true })).body).toMatchObject({ status: "received", variance: 8 });
    expect(await stock(await transitOf(t.id))).toBe(0); expect(await stock(c.fitzroy.id)).toBe(0); expect(await total()).toBe(22);
  });
  it("carries cost with the goods: the destination's average moves to the cost the stock left with", async () => {
    await receive(dc.id, 20, 4000); await receive(c.fitzroy.id, 10, 6000);
    const t = (await xfer(dc.id, c.fitzroy.id, 10)).body; await c.hqApi.post(`/transfers/${t.id}/send`); await recv(t.id, (await lineOf(t.id)).id, 10);
    expect(await avg(dc.id)).toBe(4000); expect(await avg(c.fitzroy.id)).toBe(5000);                                  // (10*6000 + 10*4000) / 20
  });
  it("is checked at both ends: a Fitzroy manager can send from and receive at Fitzroy only; transit places are not listed anywhere", async () => {
    await receive(c.fitzroy.id, 10); await receive(dc.id, 10);
    expect((await xfer(dc.id, c.fitzroy.id, 1, c.mgr)).status).toBe(403);
    const out = (await xfer(c.fitzroy.id, c.southYarra.id, 4, c.mgr)).body; expect((await c.mgr.post(`/transfers/${out.id}/send`)).status).toBe(200);
    expect((await recv(out.id, (await lineOf(out.id)).id, 4, {}, c.mgr)).status).toBe(403);
    const inbound = (await xfer(dc.id, c.fitzroy.id, 2)).body; await c.hqApi.post(`/transfers/${inbound.id}/send`); expect((await recv(inbound.id, (await lineOf(inbound.id)).id, 2, {}, c.mgr)).status).toBe(200);
    expect((await c.mgr.get("/transfers")).body.map((x: any) => x.number).sort()).toEqual([inbound.number, out.number].sort());
    const other = (await c.owner.post("/users", { email: "sy2@kestrel.test", name: "Sy", password: "south-yarra-pass-2", assignments: [{ role: "store_manager", locationId: c.southYarra.id }] })).body; expect(other.id).toBeTruthy();
    const sy = c.as((await c.login("sy2@kestrel.test", "south-yarra-pass-2")).body.token); expect((await sy.get("/transfers")).body.map((x: any) => x.number)).toEqual([out.number]); expect((await sy.get(`/transfers/${inbound.id}`)).status).toBe(403);
    expect((await c.owner.get("/locations")).body.some((l: any) => l.type === "transit")).toBe(false); expect((await c.owner.get("/overview/locations")).body.some((l: any) => l.type === "transit")).toBe(false);
  });
  it("flags a transfer that has been on the road for more than a week", async () => {
    await receive(dc.id, 10); const t = (await xfer(dc.id, c.fitzroy.id, 2)).body; await c.hqApi.post(`/transfers/${t.id}/send`);
    expect((await c.hqApi.get("/transfers")).body[0]).toMatchObject({ stuck: false, daysInTransit: 0 });
    await h.db.execute(sql`update shelfline.transfer set sent_at = now() - interval '9 days'`); expect((await c.hqApi.get("/transfers?status=sent")).body[0]).toMatchObject({ stuck: true, daysInTransit: 9 });
    expect((await c.hqApi.post(`/transfers/${(await xfer(dc.id, c.fitzroy.id, 1)).body.id}/cancel`)).body.status).toBe("cancelled");
  });
});

describe("stock counts", () => {
  const open = async (loc = c.fitzroy.id, extra: object = {}) => (await c.hqApi.post("/stock-counts", { locationId: loc, mode: "full", ...extra })).body as { id: string; number: string };
  const count = (id: string, lines: { variantId: string; countedQty: number }[]) => c.hqApi.put(`/stock-counts/${id}/lines`, { lines });
  it("committed after 3 sales since the snapshot, the adjustment is counted minus expected-at-snapshot and the sales are not overwritten", async () => {
    await receive(c.fitzroy.id, 10); const k = await open(); await sell(c.fitzroy.id, 3); expect(await stock(c.fitzroy.id)).toBe(7);
    await count(k.id, [{ variantId: vs[0]!.id, countedQty: 9 }]); await c.hqApi.post(`/stock-counts/${k.id}/submit`);
    const r = await c.hqApi.post(`/stock-counts/${k.id}/commit`, {}); expect(r.body).toMatchObject({ status: "committed", adjusted: 1, netUnits: -1 });
    expect(await stock(c.fitzroy.id)).toBe(6);                                                                       // 10 expected, 9 counted: -1 on top of the 3 sales, not "set to 9"
    expect((await h.db.execute(sql`select qty_delta::int as q from shelfline.stock_movement where kind = 'count_adjust'`)).rows).toEqual([{ q: -1 }]);
    expect((await c.hqApi.post(`/stock-counts/${k.id}/commit`, {})).status).toBe(409); expect(await stock(c.fitzroy.id)).toBe(6);
  });
  it("a blind count shows no expected figures while counting; they appear on review with what moved since, and each variance", async () => {
    await receive(c.fitzroy.id, 10); await receive(c.fitzroy.id, 5, 1000, vs[1]!.id); const k = await open();
    const blind = (await c.hqApi.get(`/stock-counts/${k.id}`)).body; expect(blind.hidden).toBe(true); expect(JSON.stringify(blind)).not.toMatch(/"expected"|"variance"|"movedSince/);
    await sell(c.fitzroy.id, 2); await count(k.id, [{ variantId: vs[0]!.id, countedQty: 10 }, { variantId: vs[1]!.id, countedQty: 4 }]); await c.hqApi.post(`/stock-counts/${k.id}/submit`);
    const rev = (await c.hqApi.get(`/stock-counts/${k.id}`)).body; expect(rev.hidden).toBe(false); expect(rev.movedSinceTotal).toBe(-2);
    expect(rev.lines.find((l: any) => l.sku === "TX-A")).toMatchObject({ expected: 10, counted: 10, variance: 0, movedSince: -2 }); expect(rev.lines.find((l: any) => l.sku === "TX-B")).toMatchObject({ expected: 5, counted: 4, variance: -1 });
    expect((await c.hqApi.put(`/stock-counts/${k.id}/lines`, { lines: [{ variantId: vs[0]!.id, countedQty: 1 }] })).status).toBe(409);        // no more counting in review
    expect((await c.hqApi.post(`/stock-counts/${k.id}/reopen`)).body.status).toBe("counting");
    const nb = await open(c.fitzroy.id, { blind: false }); expect((await c.hqApi.get(`/stock-counts/${nb.id}`)).body.hidden).toBe(false);
  });
  it("lines nobody counted must be dealt with: skipped or counted as zero. An item found that the system did not expect is added with what the system had at the snapshot", async () => {
    await receive(c.fitzroy.id, 10); await receive(c.fitzroy.id, 6, 1000, vs[1]!.id); const k = await open();
    await sell(c.fitzroy.id, 1, vs[2]!.id); await receive(c.fitzroy.id, 4, 800, vs[2]!.id);                           // TX-C had no stock record at the snapshot, then moved +3 net
    const add = await count(k.id, [{ variantId: vs[0]!.id, countedQty: 10 }, { variantId: vs[2]!.id, countedQty: 2 }]); expect(add.body).toMatchObject({ saved: 2, added: 1 });
    await c.hqApi.post(`/stock-counts/${k.id}/submit`); const rev = (await c.hqApi.get(`/stock-counts/${k.id}`)).body;
    expect(rev.lines.find((l: any) => l.sku === "TX-C")).toMatchObject({ unexpected: true, expected: 0, counted: 2, variance: 2, movedSince: 3 });
    expect((await c.hqApi.post(`/stock-counts/${k.id}/commit`, {})).body).toMatchObject({ code: "uncounted_lines", uncounted: 1 });
    expect((await c.hqApi.post(`/stock-counts/${k.id}/commit`, { uncounted: "zero" })).body).toMatchObject({ status: "committed", adjusted: 2, netUnits: -4 });   // TX-B 6 -> 0, TX-C +2
    expect(await stock(c.fitzroy.id, vs[1]!.id)).toBe(0); expect(await stock(c.fitzroy.id, vs[2]!.id)).toBe(5);
    const k2 = await open(); await c.hqApi.post(`/stock-counts/${k2.id}/submit`); expect((await c.hqApi.post(`/stock-counts/${k2.id}/commit`, { uncounted: "skip" })).body).toMatchObject({ adjusted: 0 });
  });
  it("a cycle count covers one category or a chosen list; a commit that would take stock below zero is refused whole and leaves the count in review", async () => {
    expect((await c.hqApi.post("/stock-counts", { locationId: c.fitzroy.id, mode: "cycle" })).body).toMatchObject({ code: "cycle_needs_scope" });
    expect((await c.hqApi.post("/stock-counts", { locationId: c.fitzroy.id, mode: "full" })).body).toMatchObject({ code: "nothing_to_count" });
    await receive(c.fitzroy.id, 10); const k = (await c.hqApi.post("/stock-counts", { locationId: c.fitzroy.id, mode: "cycle", categoryId: c.shoes.id })).body; expect((await c.hqApi.get(`/stock-counts/${k.id}`)).body.lines.map((l: any) => l.sku).sort()).toEqual(["TX-A", "TX-B", "TX-C"]);
    const k2 = (await c.hqApi.post("/stock-counts", { locationId: c.fitzroy.id, mode: "cycle", variantIds: [vs[0]!.id] })).body; await sell(c.fitzroy.id, 8);
    await count(k2.id, [{ variantId: vs[0]!.id, countedQty: 0 }]); await c.hqApi.post(`/stock-counts/${k2.id}/submit`);
    const r = await c.hqApi.post(`/stock-counts/${k2.id}/commit`, {}); expect(r.status).toBe(409); expect(r.body.code).toBe("insufficient_stock"); expect(await stock(c.fitzroy.id)).toBe(2);
    expect((await c.hqApi.get(`/stock-counts/${k2.id}`)).body.status).toBe("review"); expect((await c.hqApi.post(`/stock-counts/${k2.id}/cancel`)).body.status).toBe("cancelled");
    expect((await c.hqApi.get("/stock-counts?status=cancelled")).body).toHaveLength(1); expect((await c.hqApi.get(`/stock-counts?locationId=${c.fitzroy.id}`)).body.length).toBe(2);
  });
  it("needs inventory:write at the location to count, and read access to look", async () => {
    await receive(c.southYarra.id, 5); expect((await c.mgr.post("/stock-counts", { locationId: c.southYarra.id, mode: "full" })).status).toBe(403);
    const k = await open(c.southYarra.id); expect((await c.mgr.get(`/stock-counts/${k.id}`)).status).toBe(403); expect((await c.mgr.put(`/stock-counts/${k.id}/lines`, { lines: [{ variantId: vs[0]!.id, countedQty: 1 }] })).status).toBe(403);
  });
});

describe("model: any order of receipts, sales, transfers and counts keeps every location equal to the model and the ledger intact", () => {
  type Op = { k: "receive" | "sale" | "send" | "recv" | "short" | "count"; a: number; b: number; q: number };
  const op = fc.record({ k: fc.constantFrom("receive", "sale", "send", "recv", "short", "count") as fc.Arbitrary<Op["k"]>, a: fc.nat(2), b: fc.nat(2), q: fc.integer({ min: 1, max: 12 }) });
  it("random sequences", async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 22 }), async (ops) => {
      await h.db.execute(sql`truncate table shelfline.stock_movement, shelfline.stock_balance, shelfline.transfer_receipt_line, shelfline.transfer_receipt, shelfline.transfer_line, shelfline.transfer, shelfline.stock_count_line, shelfline.stock_count restart identity cascade`);
      await h.db.execute(sql`delete from shelfline.location where type = 'transit'`);
      const locs = [c.fitzroy.id, c.southYarra.id, dc.id]; const v = vs[0]!.id; const T = h.app.get(TransfersService), C = h.app.get(CountsService), L = h.app.get(LedgerService);
      const model = new Map(locs.map((l) => [l, 0])); const open: { id: string; to: string; line: string; left: number }[] = []; let lost = 0;
      for (const o of ops) {
        const loc = locs[o.a]!;
        if (o.k === "receive") { await L.append(c.orgId, c.hq.id, [{ variantId: v, locationId: loc, qtyDelta: o.q, kind: "manual_receive", sourceType: "m", sourceId: randomUUID(), unitCostMinor: 1000 }]); model.set(loc, model.get(loc)! + o.q); }
        else if (o.k === "sale") { await L.append(c.orgId, c.hq.id, [{ variantId: v, locationId: loc, qtyDelta: -o.q, kind: "sale", sourceType: "s", sourceId: randomUUID(), allowNegative: true }]); model.set(loc, model.get(loc)! - o.q); }
        else if (o.k === "send") {
          const to = locs[(o.a + 1 + (o.b % 2)) % 3]!; if (model.get(loc)! < o.q) { await expect(async () => { const t = await T.create(c.orgId, c.hq.id, { fromLocationId: loc, toLocationId: to, lines: [{ variantId: v, qty: o.q }] }, null); await T.send(c.orgId, c.hq.id, t.id, null); }).rejects.toThrow(); continue; }
          const t = await T.create(c.orgId, c.hq.id, { fromLocationId: loc, toLocationId: to, lines: [{ variantId: v, qty: o.q }] }, null); await T.send(c.orgId, c.hq.id, t.id, null);
          const d = await T.get(c.orgId, c.hq.id, t.id); model.set(loc, model.get(loc)! - o.q); open.push({ id: t.id, to, line: d.lines[0]!.id, left: o.q });
        } else if (o.k === "recv" || o.k === "short") {
          if (!open.length) continue; const i = o.a % open.length; const t = open[i]!; const take = Math.min(o.q, t.left); const closeShort = o.k === "short";
          await T.receive(c.orgId, c.hq.id, t.id, { idempotencyKey: randomUUID(), lines: [{ lineId: t.line, qty: take }], closeShort }, null);
          model.set(t.to, model.get(t.to)! + take); t.left -= take; if (closeShort) { lost += t.left; t.left = 0; } if (t.left === 0) open.splice(i, 1);
        } else {
          const k = await C.create(c.orgId, c.hq.id, { locationId: loc, mode: "cycle", blind: true, variantIds: [v] }, null).catch(() => null); if (!k) continue;
          const expected = model.get(loc)!; const counted = Math.max(0, expected + (o.q % 5) - 2); await C.setCounts(c.orgId, c.hq.id, k.id, [{ variantId: v, countedQty: counted }], null); await C.submit(c.orgId, c.hq.id, k.id, null);
          const after = expected + (counted - expected); if (after < 0) { await expect(C.commit(c.orgId, c.hq.id, k.id, {}, null)).rejects.toThrow(); await C.cancel(c.orgId, c.hq.id, k.id, null); } else { await C.commit(c.orgId, c.hq.id, k.id, {}, null); model.set(loc, after); }
        }
        // sales between operations below zero are allowed (physical), so only compare, never constrain
      }
      for (const l of locs) expect(await stock(l), `stock at ${l}`).toBe(model.get(l));
      const transitSum = Number(((await h.db.execute(sql`select coalesce(sum(b.on_hand), 0)::int as t from shelfline.stock_balance b join shelfline.location l on l.id = b.location_id where l.type = 'transit'`)).rows[0] as any).t);
      expect(transitSum).toBe(open.reduce((a, t) => a + t.left, 0)); expect(await L.check(c.orgId)).toEqual([]);
      const all = await total(); expect(all).toBe([...model.values()].reduce((a, b) => a + b, 0) + transitSum); void lost;
    }), { numRuns: 25 });
  }, 240_000);
});
