import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { LedgerService, type MovementInput } from "../src/inventory/ledger.service";
import { variant } from "../src/db/schema";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

/** Catalogue + Fitzroy, South Yarra (from world) + a Dandenong DC warehouse + 8 variants of one product. */
async function stockWorld() {
  const c = await catalogWorld(h);
  const dc = (await c.owner.post("/locations", { code: "DC", name: "Dandenong DC", type: "warehouse", timezone: "Australia/Melbourne" })).body;
  const sizes = ["9", "9.5", "10", "10.5", "11", "11.5", "12", "12.5"];
  const p = (await c.hqApi.post("/products", { title: "Tempra Glide 3", taxClassId: c.gst.id, variants: sizes.map((s) => ({ sku: `TG3-M-${s.replace(".", "")}`, barcode: `93000001${s.replace(".", "").padEnd(5, "0")}`, options: { size: s }, basePriceMinor: 21995 })) })).body;
  const v = p.variants as { id: string; sku: string }[];
  const ledger = h.app.get(LedgerService);
  const receive = (locationId: string, variantId: string, qty: number, unitCostMinor = 10000, key = randomUUID()) =>
    c.hqApi.post("/inventory/receive", { locationId, idempotencyKey: key, lines: [{ variantId, qty, unitCostMinor }] });
  const adjust = (api: { post: (u: string, b?: object) => Promise<{ status: number; body: any }> }, locationId: string, variantId: string, qtyDelta: number, reason = "damaged", key = randomUUID()) =>
    api.post("/inventory/adjust", { locationId, variantId, qtyDelta, reason, idempotencyKey: key });
  const onHand = async (variantId: string, locationId: string) => (await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${variantId} and location_id = ${locationId}`)).rows[0]?.on_hand as number | undefined;
  const sale = (variantId: string, locationId: string, qty: number, sourceId = randomUUID(), allowNegative = true): MovementInput => ({ variantId, locationId, qtyDelta: -qty, kind: "sale", sourceType: "sale", sourceId, allowNegative });
  return { ...c, dc, v, ledger, receive, adjust, onHand, sale };
}

describe("receiving and idempotency", () => {
  it("receives stock; the same idempotency key three times has one effect", async () => {
    const s = await stockWorld();
    const key = randomUUID();
    const r = [await s.receive(s.fitzroy.id, s.v[0]!.id, 12, 10000, key), await s.receive(s.fitzroy.id, s.v[0]!.id, 12, 10000, key), await s.receive(s.fitzroy.id, s.v[0]!.id, 12, 10000, key)];
    expect(r.map((x) => x.body)).toEqual([{ applied: 1, duplicates: 0, negative: [] }, { applied: 0, duplicates: 1, negative: [] }, { applied: 0, duplicates: 1, negative: [] }]);
    expect(await s.onHand(s.v[0]!.id, s.fitzroy.id)).toBe(12);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.stock_movement`)).rows[0]).toEqual({ n: 1 });
    expect((await s.owner.get("/audit?action=inventory.receive")).body).toHaveLength(1); // a replay is not audited again
  });
  it("10 concurrent replays of one event also have one effect", async () => {
    const s = await stockWorld();
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.receive(s.fitzroy.id, s.v[1]!.id, 5, 10000, key)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.reduce((a, r) => a + r.body.applied, 0)).toBe(1);
    expect(await s.onHand(s.v[1]!.id, s.fitzroy.id)).toBe(5);
  });
  it("moving-average cost: 10 @ 100.00 then 10 @ 120.00 = 110.00; a sale snapshots it; receiving into negative resets the average", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id;
    await s.receive(s.dc.id, vid, 10, 10000); await s.receive(s.dc.id, vid, 10, 12000);
    expect((await h.db.execute(sql`select avg_cost_minor from shelfline.stock_balance where variant_id = ${vid}`)).rows[0]).toEqual({ avg_cost_minor: 11000 });
    await s.ledger.append(s.orgId, null, [s.sale(vid, s.dc.id, 1)]);
    expect((await h.db.execute(sql`select unit_cost_minor from shelfline.stock_movement where kind = 'sale'`)).rows[0]).toEqual({ unit_cost_minor: 11000 });
    const vid2 = s.v[1]!.id;
    await s.ledger.append(s.orgId, null, [s.sale(vid2, s.dc.id, 3)]);               // on hand -3
    await s.receive(s.dc.id, vid2, 10, 9000);                                           // on hand 7, average restarts at the receipt cost
    expect((await h.db.execute(sql`select avg_cost_minor, on_hand from shelfline.stock_balance where variant_id = ${vid2}`)).rows[0]).toEqual({ avg_cost_minor: 9000, on_hand: 7 });
  });
});

describe("adjustments and the no-oversell rule", () => {
  it("manual adjustments need a valid reason, cannot go negative, and leave nothing behind when refused", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id;
    await s.receive(s.fitzroy.id, vid, 3);
    expect((await s.hqApi.post("/inventory/adjust", { locationId: s.fitzroy.id, variantId: vid, qtyDelta: -1, idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, -1, "because")).status).toBe(400);
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, 0)).status).toBe(400);
    const over = await s.adjust(s.hqApi, s.fitzroy.id, vid, -4);
    expect(over.status).toBe(409); expect(over.body).toMatchObject({ code: "insufficient_stock", onHand: 3, wanted: 4 });
    expect(await s.onHand(vid, s.fitzroy.id)).toBe(3);
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, -2, "damaged")).status).toBe(200);
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, 4, "found")).status).toBe(200);
    expect(await s.onHand(vid, s.fitzroy.id)).toBe(5);
    const a = (await s.owner.get("/audit?action=inventory.adjust")).body;
    expect(a).toHaveLength(2); expect(a[1].after).toMatchObject({ qtyDelta: -2, reason: "damaged" });
  });
  it("50 concurrent -1 adjustments against 10 in stock: exactly 10 succeed, stock ends at 0, never negative", async () => {
    const s = await stockWorld(); const vid = s.v[2]!.id;
    await s.receive(s.fitzroy.id, vid, 10);
    const rs = await Promise.all(Array.from({ length: 50 }, () => s.adjust(s.hqApi, s.fitzroy.id, vid, -1)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(10);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(40);
    expect(await s.onHand(vid, s.fitzroy.id)).toBe(0);
    expect((await h.db.execute(sql`select count(*)::int as n, sum(qty_delta)::int as s from shelfline.stock_movement where kind = 'manual_adjust'`)).rows[0]).toEqual({ n: 10, s: -10 });
    expect((await s.hqApi.get("/inventory-check")).body.ok).toBe(true);
  });
  it("a sale is a physical fact: it may drive stock negative, is flagged, and shows in the stock card; other kinds may not", async () => {
    const s = await stockWorld(); const vid = s.v[3]!.id;
    await s.receive(s.southYarra.id, vid, 1);
    const r = await s.ledger.append(s.orgId, null, [s.sale(vid, s.southYarra.id, 2)]);
    expect(r.negative).toEqual([{ variantId: vid, locationId: s.southYarra.id, onHand: -1 }]);
    expect(await s.onHand(vid, s.southYarra.id)).toBe(-1);
    const card = (await s.hqApi.get(`/inventory/${vid}/ledger?locationId=${s.southYarra.id}`)).body;
    expect(card.onHand).toBe(-1);
    expect(card.movements.map((m: { balance: number }) => m.balance)).toEqual([-1, 1]);
    expect(card.movements[0].flags).toEqual(["negative_stock"]);
    await expect(s.ledger.append(s.orgId, null, [s.sale(vid, s.southYarra.id, 1, randomUUID(), false)])).rejects.toMatchObject({ response: { code: "insufficient_stock" } });
    await expect(s.ledger.append(s.orgId, null, [{ ...s.sale(vid, s.southYarra.id, 1), kind: "transfer_out", allowNegative: true }])).rejects.toMatchObject({ response: { code: "negative_not_allowed_for_kind" } });
  });
  it("receiving into a negative position is accepted (it can only reduce the shortfall); the flag is only for outflows", async () => {
    const s = await stockWorld(); const vid = s.v[4]!.id;
    await s.ledger.append(s.orgId, null, [s.sale(vid, s.fitzroy.id, 10)]);                  // -10, flagged
    const r = await s.receive(s.fitzroy.id, vid, 4);                                           // -6: still negative, but better
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: 1, negative: [] });
    expect(await s.onHand(vid, s.fitzroy.id)).toBe(-6);
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, -1)).status).toBe(409);               // making it worse by hand is still refused
    expect((await s.hqApi.get(`/inventory/${vid}/ledger?locationId=${s.fitzroy.id}`)).body.movements.map((m: { flags: string[] }) => m.flags)).toEqual([[], ["negative_stock"]]);
  });
  it("a batch is all-or-nothing: if one line is refused, no line is applied", async () => {
    const s = await stockWorld();
    await s.receive(s.fitzroy.id, s.v[0]!.id, 5);
    const batch: MovementInput[] = [
      { variantId: s.v[1]!.id, locationId: s.fitzroy.id, qtyDelta: 7, kind: "manual_receive", sourceType: "t", sourceId: "b1" },
      { variantId: s.v[0]!.id, locationId: s.fitzroy.id, qtyDelta: -6, kind: "write_off", sourceType: "t", sourceId: "b2", reason: "damaged" },
    ];
    await expect(s.ledger.append(s.orgId, null, batch)).rejects.toMatchObject({ response: { code: "insufficient_stock" } });
    expect(await s.onHand(s.v[1]!.id, s.fitzroy.id)).toBeUndefined();
    expect(await s.onHand(s.v[0]!.id, s.fitzroy.id)).toBe(5);
  });
  it("sign and reason rules per kind; local business date follows the location's time zone and cutoff", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id; const loc = s.fitzroy.id;
    const base = { variantId: vid, locationId: loc, sourceType: "t" };
    await expect(s.ledger.append(s.orgId, null, [{ ...base, qtyDelta: 1, kind: "sale", sourceId: "1" }])).rejects.toMatchObject({ response: { code: "kind_requires_negative" } });
    await expect(s.ledger.append(s.orgId, null, [{ ...base, qtyDelta: -1, kind: "manual_receive", sourceId: "2" }])).rejects.toMatchObject({ response: { code: "kind_requires_positive" } });
    await expect(s.ledger.append(s.orgId, null, [{ ...base, qtyDelta: 1, kind: "count_adjust", sourceId: "3" }])).rejects.toMatchObject({ response: { code: "reason_required" } });
    await s.ledger.append(s.orgId, null, [{ ...base, qtyDelta: 4, kind: "manual_receive", sourceId: "4", at: new Date("2026-11-03T15:30:00Z") }]); // 02:30 AEDT on 4 Nov, cutoff 04:00
    expect((await h.db.execute(sql`select local_date::text as d from shelfline.stock_movement where source_id = '4'`)).rows[0]).toEqual({ d: "2026-11-03" });
  });
});

describe("locking", () => {
  it("batches that touch the same variants in opposite orders never deadlock", async () => {
    const s = await stockWorld();
    const rows = (tag: string, order: typeof s.v): MovementInput[] => order.map((x, i) => ({ variantId: x.id, locationId: s.fitzroy.id, qtyDelta: 1, kind: "manual_receive", sourceType: "race", sourceId: tag, lineNo: i }));
    const fwd = s.v, rev = [...s.v].reverse();
    const jobs = Array.from({ length: 24 }, (_, i) => s.ledger.append(s.orgId, null, rows(`b${i}`, i % 2 ? rev : fwd).map((m, k) => ({ ...m, lineNo: k + 1, sourceId: `b${i}-${m.variantId}` }))));
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    for (const x of s.v) expect(await s.onHand(x.id, s.fitzroy.id)).toBe(24);
    expect((await s.hqApi.get("/inventory-check")).body.ok).toBe(true);
  });
});

describe("the ledger cannot be edited", () => {
  it("UPDATE and DELETE on stock_movement are refused by the database", async () => {
    const s = await stockWorld();
    await s.receive(s.fitzroy.id, s.v[0]!.id, 2);
    await expect(h.db.execute(sql`update shelfline.stock_movement set qty_delta = 99`)).rejects.toThrow();
    await expect(h.db.execute(sql`delete from shelfline.stock_movement`)).rejects.toThrow();
    expect(await s.onHand(s.v[0]!.id, s.fitzroy.id)).toBe(2);
  });
  it("the invariant check detects a balance that no longer matches the ledger", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id;
    await s.receive(s.fitzroy.id, vid, 5);
    expect((await s.hqApi.get("/inventory-check")).body).toEqual({ ok: true, mismatches: [] });
    await h.db.execute(sql`update shelfline.stock_balance set on_hand = 6 where variant_id = ${vid}`);
    const bad = (await s.hqApi.get("/inventory-check")).body;
    expect(bad.ok).toBe(false); expect(bad.mismatches).toEqual([{ variantId: vid, locationId: s.fitzroy.id, onHand: 6, ledgerSum: 5 }]);
    await h.db.execute(sql`delete from shelfline.stock_balance where variant_id = ${vid}`);
    expect((await s.hqApi.get("/inventory-check")).body.mismatches).toEqual([{ variantId: vid, locationId: s.fitzroy.id, onHand: 0, ledgerSum: 5 }]); // movements without a balance row
  });
  it("replaying an already-applied event is a duplicate even when stock has since dropped (never re-judged against today's stock)", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id;
    await s.receive(s.fitzroy.id, vid, 3);
    const key = randomUUID();
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, -3, "damaged", key)).body.applied).toBe(1);
    const again = await s.adjust(s.hqApi, s.fitzroy.id, vid, -3, "damaged", key);   // stock is 0 now; a fresh -3 would be refused
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ applied: 0, duplicates: 1 });
    expect((await s.adjust(s.hqApi, s.fitzroy.id, vid, -3, "damaged")).status).toBe(409); // a NEW event is still refused
    expect(await s.onHand(vid, s.fitzroy.id)).toBe(0);
  });
  it("model check: random receipts, adjustments, sales and replays always leave balance = sum of ledger and match a simple model", async () => {
    const s = await stockWorld();
    const ids = s.v.slice(0, 3).map((x) => x.id); const locs = [s.fitzroy.id, s.southYarra.id, s.dc.id];
    const op = fc.record({ kind: fc.constantFrom("receive", "adjust", "sale", "replay"), v: fc.integer({ min: 0, max: 2 }), l: fc.integer({ min: 0, max: 2 }), q: fc.integer({ min: 1, max: 6 }) });
    const model = new Map<string, number>(); const applied = new Map<string, MovementInput>();
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 5, maxLength: 40 }), async (ops: { kind: string; v: number; l: number; q: number }[]) => {
      for (const o of ops) {
        const vid = ids[o.v]!, lid = locs[o.l]!; const key = `${vid}|${lid}`;
        let m: MovementInput; let replay = false;
        if (o.kind === "replay" && applied.size) { m = [...applied.values()][o.q % applied.size]!; replay = true; }
        else if (o.kind === "adjust") m = { variantId: vid, locationId: lid, qtyDelta: -o.q, kind: "manual_adjust", sourceType: "m", sourceId: randomUUID(), reason: "damaged" };
        else if (o.kind === "sale") m = s.sale(vid, lid, o.q);
        else m = { variantId: vid, locationId: lid, qtyDelta: o.q, kind: "manual_receive", sourceType: "m", sourceId: randomUUID() };
        const cur = model.get(`${m.variantId}|${m.locationId}`) ?? (Number(await s.onHand(m.variantId, m.locationId)) || 0);
        try {
          const r = await s.ledger.append(s.orgId, null, [m]);
          if (replay) expect(r.duplicates).toBe(1);
          else { expect(r.applied).toBe(1); applied.set(m.sourceId, m); model.set(`${m.variantId}|${m.locationId}`, cur + m.qtyDelta); }
        } catch (e) {
          const code = (e as { response?: { code?: string } }).response?.code;
          expect({ kind: m.kind, code, wouldGoNegative: cur + m.qtyDelta < 0 }).toEqual({ kind: "manual_adjust", code: "insufficient_stock", wouldGoNegative: true });
        }
        void key;
      }
      expect(await s.ledger.check(s.orgId)).toEqual([]);
      for (const [k, expected] of model) { const [vi, li] = k.split("|") as [string, string]; expect(Number(await s.onHand(vi, li))).toBe(expected); }
    }), { numRuns: 25 });
  }, 120_000);
});

describe("scope, cost visibility and validation", () => {
  it("a Fitzroy store manager sees and changes Fitzroy stock only; the cashier can read but not write; cost is hidden without cost:read", async () => {
    const s = await stockWorld(); const vid = s.v[0]!.id;
    await s.receive(s.fitzroy.id, vid, 6, 11840); await s.receive(s.southYarra.id, vid, 3, 11840);
    const mine = (await s.mgr.get("/inventory")).body;
    expect(mine.map((r: { locationId: string }) => r.locationId)).toEqual([s.fitzroy.id]);
    expect(mine[0]).toMatchObject({ onHand: 6, sku: "TG3-M-9" }); expect("avgCostMinor" in mine[0] && mine[0].avgCostMinor !== undefined).toBe(false);
    const hq = (await s.hqApi.get("/inventory")).body;
    expect(hq).toHaveLength(2); expect(hq[0].avgCostMinor).toBe(11840);
    expect((await s.mgr.get(`/inventory/${vid}/ledger?locationId=${s.southYarra.id}`)).status).toBe(403);
    const own = (await s.mgr.get(`/inventory/${vid}/ledger?locationId=${s.fitzroy.id}`)).body;
    expect(own.movements[0]).not.toHaveProperty("unitCostMinor");
    expect((await s.hqApi.get(`/inventory/${vid}/ledger?locationId=${s.fitzroy.id}`)).body.movements[0].unitCostMinor).toBe(11840);
    expect((await s.adjust(s.mgr, s.southYarra.id, vid, -1)).status).toBe(403);
    expect((await s.adjust(s.mgr, s.fitzroy.id, vid, -1)).status).toBe(200);
    const pin = (await h.http().post("/pos/pin").set("x-device-key", s.device.key).send({ employeeCode: "117", pin: "4821" })).body.token;
    expect((await h.http().get("/inventory").set("Authorization", `Bearer ${pin}`)).status).toBe(200);
    expect((await h.http().post("/inventory/adjust").set("Authorization", `Bearer ${pin}`).send({})).status).toBe(401);
    expect((await s.mgr.get("/inventory-check")).status).toBe(403);
  });
  it("search by SKU, title and barcode; validation of receipts and locations", async () => {
    const s = await stockWorld();
    await s.receive(s.fitzroy.id, s.v[0]!.id, 4); await s.receive(s.fitzroy.id, s.v[1]!.id, 2);
    expect((await s.hqApi.get("/inventory?q=TG3-M-95")).body).toHaveLength(1);
    expect((await s.hqApi.get("/inventory?q=glide")).body).toHaveLength(2);
    const dup = await s.hqApi.post("/inventory/receive", { locationId: s.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: s.v[0]!.id, qty: 1, unitCostMinor: 1 }, { variantId: s.v[0]!.id, qty: 1, unitCostMinor: 1 }] });
    expect(dup.status).toBe(400);
    expect((await s.hqApi.post("/inventory/receive", { locationId: s.fitzroy.id, idempotencyKey: "not-a-uuid", lines: [{ variantId: s.v[0]!.id, qty: 1, unitCostMinor: 1 }] })).status).toBe(400);
    expect((await s.hqApi.post("/inventory/receive", { locationId: s.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: s.v[0]!.id, qty: 1.5, unitCostMinor: 1 }] })).status).toBe(400);
    expect((await s.hqApi.post("/inventory/receive", { locationId: s.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: randomUUID(), qty: 1, unitCostMinor: 1 }] })).status).toBe(404);
    const virtual = (await s.owner.post("/locations", { code: "WEB", name: "Online", type: "virtual", timezone: "Australia/Melbourne" })).body;
    expect((await s.receive(virtual.id, s.v[0]!.id, 1)).body.code).toBe("location_cannot_hold_stock");
    await s.owner.patch(`/locations/${s.southYarra.id}`, { status: "inactive" });
    expect((await s.receive(s.southYarra.id, s.v[0]!.id, 1)).body.code).toBe("location_cannot_hold_stock");
    await s.hqApi.patch(`/variants/${s.v[2]!.id}`, { trackStock: false });
    expect((await s.receive(s.fitzroy.id, s.v[2]!.id, 1)).body.code).toBe("stock_not_tracked");
    await h.db.update(variant).set({ trackStock: true }).where(eq(variant.id, s.v[2]!.id));
  });
});
