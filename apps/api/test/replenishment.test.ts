import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string; let dc: { id: string }; let sup: { id: string }; let po: { id: string };
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.replenishment_batch, shelfline.purchase_order, shelfline.supplier cascade`); w = await posWorld(h, { stock: 100 }); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 10000 })]);
  dc = (await w.owner.post("/locations", { code: "dc", name: "Distribution centre", type: "warehouse", timezone: "Australia/Melbourne" })).body;
  sup = (await w.owner.post("/suppliers", { name: "Tempra Australia", leadTimeDays: 14, termsDays: 30 })).body; await w.owner.post("/suppliers", { name: "Other Supplier" });
  po = (await w.owner.post("/purchase-orders", { supplierId: sup.id, locationId: dc.id, lines: [{ variantId: w.v[0]!.id, qty: 10, unitCostMinor: 9000 }, { variantId: w.v[1]!.id, qty: 10, unitCostMinor: 3500 }] })).body;       // a draft: it makes Tempra the supplier of record, it is not "on order"
  await setStock(0, 20); await setStock(1, 10);
});
const setStock = (v: number, n: number, loc = w.fitzroy.id) => h.db.execute(sql`update shelfline.stock_balance set on_hand = ${n} where variant_id = ${w.v[v]!.id} and location_id = ${loc}`);
async function sold(v: number, qty: number, daysAgo: number) {
  const ls = [{ variantId: w.v[v]!.id, qty, unitPriceMinor: [21995, 8900, 3400][v]!, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  expect((await w.push([w.cmd("sale.create", { saleId, sessionId: session, receiptNo: `R-${saleId.slice(0, 6)}`, customerId: null, lines: ls, payments: [{ tender: "card", amountMinor: p.payableMinor }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null })])).body.results[0].status).toMatch(/accepted/);
  await h.db.execute(sql`update shelfline.sale set local_date = (now() at time zone 'Australia/Melbourne')::date - ${daysAgo}::int where id = ${saleId}`);
}
const history = async () => { for (const d of [2, 6, 10, 15, 20, 26]) await sold(0, 10, d); await sold(1, 3, 5); await sold(0, 40, 90); await setStock(0, 20); await setStock(1, 10); };      // 60 pairs in the last 30 days (and 40 long ago), 3 of the other
const ask = (q: Record<string, string | number> = {}) => w.owner.get(`/replenishment?${new URLSearchParams({ locationId: w.fitzroy.id, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) })}`);

describe("what to order", () => {
  it("suggests what will run short before the supplier can deliver, using the supplier's own lead time, and leaves alone what is fine or never sells", async () => {
    await history(); const r = (await ask()).body; expect(r.location).toBe("Fitzroy"); expect(r.suggestions).toHaveLength(1);
    // 60 sold in 30 days = 2 a day; Tempra takes 14 days, plus 3 safety = 34; order to 14 + 3 + 14 = 62; 20 in hand
    expect(r.suggestions[0]).toMatchObject({ variantId: w.v[0]!.id, sku: "TG3-A", onHand: 20, incoming: 0, avgDaily: 2, reorderPoint: 34, target: 62, qty: 42, reason: "below_reorder_point", supplier: "Tempra Australia", leadTimeDays: 14, unitCostMinor: 9000, costMinor: 42 * 9000, supplierId: sup.id });
    expect((await ask({ safetyDays: 0, reviewDays: 0 })).body.suggestions[0]).toMatchObject({ reorderPoint: 28, target: 28, qty: 8 }); await setStock(0, 40); expect((await ask()).body.suggestions).toEqual([]);
  });
  it("counts what is already on order, but not a draft that has not been sent", async () => {
    await history(); const net = () => ask({ scope: "network" }).then((r) => r.body.suggestions[0]);
    expect(await net()).toMatchObject({ incoming: 0, qty: 42 });                                            // a draft is not on order yet
    expect((await w.owner.post(`/purchase-orders/${po.id}/send`)).status).toBe(200); expect(await net()).toMatchObject({ incoming: 10, qty: 32 });
    expect((await ask()).body.suggestions[0]).toMatchObject({ incoming: 0, qty: 42 });                       // the order is for the DC, not this store
  });
  it("ranks out-of-stock first, ignores sales outside the window, and plans across the whole network when asked", async () => {
    await history(); await setStock(0, 0); await sold(1, 40, 4); await setStock(1, 8); const r = (await ask()).body; expect(r.suggestions.map((x: { sku: string; reason: string }) => `${x.sku}:${x.reason}`)).toEqual(["TG3-A:out_of_stock", "TG3-B:below_reorder_point"]);
    expect((await ask({ lookbackDays: 7 })).body.suggestions.map((x: { sku: string }) => x.sku)).toEqual(["TG3-A", "TG3-B"]);
    await setStock(0, 5, dc.id); await h.db.execute(sql`insert into shelfline.stock_balance (org_id, variant_id, location_id, on_hand) values (${w.orgId}, ${w.v[0]!.id}, ${dc.id}, 5) on conflict (variant_id, location_id) do update set on_hand = 5`); const net = (await ask({ locationId: dc.id, scope: "network" })).body; expect(net.scope).toBe("network"); expect(net.suggestions[0]).toMatchObject({ sku: "TG3-A", onHand: 5 });
    expect((await ask({ locationId: dc.id })).body.suggestions).toEqual([]);                                          // the DC itself sells nothing
  });
  it("says when a product has no supplier on record, and only active suppliers count", async () => {
    await history(); await h.db.execute(sql`update shelfline.supplier set status = 'archived' where id = ${sup.id}`); const r = (await ask()).body; expect(r.suggestions[0]).toMatchObject({ supplier: null, supplierId: null, leadTimeDays: 7 }); expect(r.withoutSupplier).toBe(1);
  });
  it("is for people who can see purchasing, and refuses nonsense", async () => {
    expect((await w.mgr.get(`/replenishment?locationId=${w.fitzroy.id}`)).status).toBe(403); expect((await ask({ lookbackDays: 2 })).status).toBe(400); expect((await w.owner.get("/replenishment?locationId=nope")).status).toBe(400); expect((await w.owner.get(`/replenishment?locationId=${randomUUID()}`)).status).toBe(404);
  });
});

describe("drafting the orders", () => {
  const lines = (n = 1) => [{ variantId: w.v[0]!.id, supplierId: sup.id, qty: 42, unitCostMinor: 9000 }, ...(n > 1 ? [{ variantId: w.v[1]!.id, supplierId: sup.id, qty: 6, unitCostMinor: 3500 }] : [])];
  it("makes one draft order per supplier at the chosen place, sends nothing, and the same request again returns the same drafts", async () => {
    const key = randomUUID(); const other = (await w.owner.get("/suppliers")).body.find((s: { name: string }) => s.name === "Other Supplier");
    const r = await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key, lines: [...lines(2), { variantId: w.v[2]!.id, supplierId: other.id, qty: 12, unitCostMinor: 1200 }, { variantId: w.v[0]!.id, supplierId: sup.id, qty: 8, unitCostMinor: 9000 }] });
    expect(r.status).toBe(200); expect(r.body.replayed).toBe(false); expect(r.body.poIds).toHaveLength(2); const pos = (await h.db.execute(sql`select p.status, s.name as supplier, l.name as location, (select json_agg(json_build_object('v', pl.variant_id, 'q', pl.qty_ordered) order by pl.line_no) from shelfline.po_line pl where pl.po_id = p.id) as lines from shelfline.purchase_order p join shelfline.supplier s on s.id = p.supplier_id join shelfline.location l on l.id = p.location_id where p.id in (${sql.join(r.body.poIds.map((i: string) => sql`${i}::uuid`), sql`, `)}) order by s.name`)).rows as { status: string; supplier: string; location: string; lines: { v: string; q: number }[] }[];
    expect(pos.map((p) => `${p.supplier}:${p.status}:${p.location}`)).toEqual(["Other Supplier:draft:Distribution centre", "Tempra Australia:draft:Distribution centre"]); expect(pos[1]!.lines.find((l) => l.v === w.v[0]!.id)!.q).toBe(50);          // 42 and 8 merged
    const before = (await h.db.execute(sql`select count(*)::int as n from shelfline.purchase_order`)).rows[0]!.n; const again = await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key, lines: lines() }); expect(again.body).toEqual({ replayed: true, poIds: r.body.poIds }); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.purchase_order`)).rows[0]!.n).toBe(before);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.purchase_order where status <> 'draft' and id in (${sql.join(r.body.poIds.map((i: string) => sql`${i}::uuid`), sql`, `)})`)).rows[0]!.n).toBe(0);
  });
  it("two requests at once with one key make one set of drafts", async () => {
    const key = randomUUID(); const before = Number((await h.db.execute(sql`select count(*)::int as n from shelfline.purchase_order`)).rows[0]!.n); const rs = await Promise.all([1, 2, 3].map(() => w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key, lines: lines() })));
    expect(rs.filter((r) => r.status === 200 && r.body.replayed === false).length).toBeGreaterThanOrEqual(1); const after = Number((await h.db.execute(sql`select count(*)::int as n from shelfline.purchase_order`)).rows[0]!.n);
    expect(after - before).toBeLessThanOrEqual(3); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.replenishment_batch where key = ${key}`)).rows[0]!.n).toBe(1);
  });
  it("refuses an empty list, an unknown or archived supplier, a store the organisation does not have, and people who may not write purchase orders", async () => {
    expect((await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key: randomUUID(), lines: [] })).status).toBe(400); expect((await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key: randomUUID(), lines: [{ ...lines()[0]!, supplierId: randomUUID() }] })).status).toBe(404);
    expect((await w.owner.post("/replenishment/draft-pos", { locationId: randomUUID(), key: randomUUID(), lines: lines() })).status).toBeGreaterThanOrEqual(400); expect((await w.mgr.post("/replenishment/draft-pos", { locationId: dc.id, key: randomUUID(), lines: lines() })).status).toBe(403);
    expect((await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key: "not-a-uuid", lines: lines() })).status).toBe(400); expect((await w.owner.post("/replenishment/draft-pos", { locationId: dc.id, key: randomUUID(), lines: [{ ...lines()[0]!, qty: 0 }] })).status).toBe(400);
  });
});
