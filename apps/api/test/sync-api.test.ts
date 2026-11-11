import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { SCHEMA_V } from "@shelfline/contracts";
import { uuidv7 } from "@shelfline/sync-client";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

/** Catalogue (2 variants), stock at Fitzroy (10) and South Yarra (5), a store manager and a cashier at Fitzroy, and a POS token for the Fitzroy device. */
async function syncWorld() {
  const c = await catalogWorld(h);
  const p = (await c.hqApi.post("/products", { title: "Tempra Glide 3", taxClassId: c.gst.id, variants: [
    { sku: "TG3-A", barcode: "9300000200001", basePriceMinor: 21995, costMinor: 11840 }, { sku: "TG3-B", barcode: "9300000200002", basePriceMinor: 21995, costMinor: 11840 }] })).body;
  const v = p.variants as { id: string }[];
  const rec = (loc: string, vid: string, qty: number) => c.hqApi.post("/inventory/receive", { locationId: loc, idempotencyKey: randomUUID(), lines: [{ variantId: vid, qty, unitCostMinor: 11840 }] });
  await rec(c.fitzroy.id, v[0]!.id, 10); await rec(c.southYarra.id, v[0]!.id, 5);
  const login = async () => (await h.http().post("/pos/pin").set("x-device-key", c.device.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
  const tok = await login();
  const posGet = (path: string, t = tok) => h.http().get(path).set("Authorization", `Bearer ${t}`);
  const push = (commands: object[], deviceNow = new Date().toISOString(), t = tok) => h.http().post("/sync/push").set("Authorization", `Bearer ${t}`).send({ deviceNow, commands });
  let seq = 0;
  const cmd = (type: string, payload: unknown, o: { seq?: number; actorId?: string; schemaV?: number; clientTs?: string; id?: string } = {}) =>
    ({ id: o.id ?? uuidv7(), seq: o.seq ?? ++seq, type, payload, clientTs: o.clientTs ?? new Date().toISOString(), schemaV: o.schemaV ?? SCHEMA_V, actorId: o.actorId ?? c.manager.id });
  const adjust = (vid: string, qtyDelta: number, o: Parameters<typeof cmd>[2] = {}) => cmd("stock.adjust", { variantId: vid, qtyDelta, reason: "damaged" }, o);
  const onHand = async (vid: string, loc = c.fitzroy.id) => Number((await h.db.execute(sql`select on_hand from shelfline.stock_balance where variant_id = ${vid} and location_id = ${loc}`)).rows[0]?.on_hand);
  return { ...c, v, tok, posGet, push, cmd, adjust, onHand, rec, resetSeq: () => { seq = 0; } };
}

describe("push", () => {
  it("applies a command once, records a receipt, advances the device sequence; replays answer duplicate with the original result", async () => {
    const s = await syncWorld();
    const c1 = s.adjust(s.v[0]!.id, -3);
    const r1 = await s.push([c1]);
    expect(r1.status).toBe(200);
    expect(r1.body.results).toMatchObject([{ id: c1.id, seq: 1, status: "accepted", result: { applied: 1 } }]);
    expect(r1.body.expectedSeq).toBe(2);
    expect(await s.onHand(s.v[0]!.id)).toBe(7);
    const r2 = await s.push([c1]); const r3 = await s.push([c1]);
    expect(r2.body.results[0]).toMatchObject({ status: "duplicate", detail: { original: "accepted" }, result: { applied: 1 } }); expect(r3.body.results[0].status).toBe("duplicate");
    expect(await s.onHand(s.v[0]!.id)).toBe(7);
    const { rows } = await h.db.execute(sql`select count(*)::int as n from shelfline.sync_command_receipt`); expect(rows[0]).toEqual({ n: 1 });
  });
  it("a batch is processed in device order even if sent shuffled", async () => {
    const s = await syncWorld();
    const [a, b, c] = [s.adjust(s.v[0]!.id, -1), s.adjust(s.v[0]!.id, -1), s.adjust(s.v[0]!.id, -1)];
    const r = await s.push([c, a, b]);
    expect(r.body.results.map((x: { seq: number; status: string }) => `${x.seq}:${x.status}`)).toEqual(["1:accepted", "2:accepted", "3:accepted"]);
    expect(r.body.expectedSeq).toBe(4);
  });
  it("a command that skips a number is reported as a gap and not applied; the missing ones then fill it in", async () => {
    const s = await syncWorld();
    const [c1, c2, c3] = [s.adjust(s.v[0]!.id, -1), s.adjust(s.v[0]!.id, -1), s.adjust(s.v[0]!.id, -1)];
    const early = await s.push([c3]);
    expect(early.body.results).toMatchObject([{ seq: 3, status: "gap", detail: { expected: 1 } }]); expect(early.body.expectedSeq).toBe(1);
    expect(await s.onHand(s.v[0]!.id)).toBe(10);
    const rest = await s.push([c1, c2, c3]);
    expect(rest.body.results.map((x: { status: string }) => x.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(await s.onHand(s.v[0]!.id)).toBe(7);
  });
  it("business and protocol refusals are recorded as rejected, advance the sequence, and never block later commands", async () => {
    const s = await syncWorld(); const vid = s.v[0]!.id;
    const cashierAdjust = s.adjust(vid, -1, { actorId: s.cashier.id });          // cashier lacks inventory:write
    const nobody = s.adjust(vid, -1, { actorId: randomUUID() });
    const wrongPlace = s.adjust(vid, -1, { actorId: (await s.owner.post("/users", { email: "sy@kestrel.test", name: "SY", assignments: [{ role: "store_manager", locationId: s.southYarra.id }] })).body.id });
    const unknown = s.cmd("sale.teleport", {});
    const bad = s.cmd("stock.adjust", { variantId: "nope", qtyDelta: 0 });
    const old = s.adjust(vid, -1, { schemaV: 0 }); const future = s.adjust(vid, -1, { schemaV: 99 });
    const tooMuch = s.adjust(vid, -50);                                          // would go negative: refused by the ledger
    const fine = s.adjust(vid, -2);
    const r = await s.push([cashierAdjust, nobody, wrongPlace, unknown, bad, old, future, tooMuch, fine]);
    expect(r.body.results.map((x: { status: string; reason?: string }) => `${x.status}:${x.reason ?? ""}`)).toEqual([
      "rejected:forbidden", "rejected:actor_not_assigned", "rejected:actor_not_assigned", "rejected:unknown_command", "rejected:invalid_payload",
      "rejected:update_required", "rejected:unsupported_schema", "rejected:insufficient_stock", "accepted:"]);
    expect(await s.onHand(vid)).toBe(8); expect(r.body.expectedSeq).toBe(10);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.stock_movement where source_type = 'sync.stock.adjust'`)).rows[0]).toEqual({ n: 1 }); // the refused ones left no movement
  });
  it("10 overlapping pushes of the same batch have exactly one effect", async () => {
    const s = await syncWorld();
    const batch = [s.adjust(s.v[0]!.id, -1), s.adjust(s.v[0]!.id, -1), s.adjust(s.v[1]!.id, 0 + 1)];
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.push(batch)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.some((r) => r.body.halted)).toBe(false);                                   // nobody is told to retry: the losers get clean `duplicate` answers
    expect(rs.every((r) => r.body.results.length === 3)).toBe(true);
    const applied = rs.flatMap((r) => r.body.results).filter((x: { status: string }) => x.status === "accepted");
    expect(applied).toHaveLength(3);
    expect(await s.onHand(s.v[0]!.id)).toBe(8);
    expect((await h.db.execute(sql`select last_seq from shelfline.device where id = ${s.device.id}`)).rows[0]).toEqual({ last_seq: "3" });
  });
  it("device clock: a small skew is corrected, a large one is flagged and the server time is used", async () => {
    const s = await syncWorld();
    const sent = new Date(Date.now() - 20_000).toISOString();          // the command was made 20 s ago by the device's clock
    const small = await s.push([s.adjust(s.v[0]!.id, -1, { clientTs: sent })], new Date(Date.now() + 30_000).toISOString());   // device clock 30 s fast
    expect(small.body.results[0].status).toBe("accepted"); expect(Math.abs(small.body.skewMs - 30_000)).toBeLessThan(1500);
    const eff = (await h.db.execute(sql`select extract(epoch from effective_at) * 1000 as e, extract(epoch from client_ts) * 1000 as c from shelfline.sync_command_receipt`)).rows[0] as { e: string; c: string };
    expect(Math.round((Number(eff.c) - Number(eff.e)) / 1000)).toBe(30);   // effective time = client time minus the measured skew
    const big = await s.push([s.adjust(s.v[0]!.id, -1)], new Date(Date.now() + 10 * 60_000).toISOString());
    expect(big.body.results[0]).toMatchObject({ status: "accepted_flagged", flags: ["skewed_clock"] });
    expect((await s.posGet("/sync/exceptions")).status).toBe(401);                           // exceptions are an admin read
    expect((await s.hqApi.get("/sync/exceptions")).status).toBe(403);                        // HQ has no audit:read
  });
  it("only a POS token of an active POS device may use sync; revoking the device cuts it off", async () => {
    const s = await syncWorld();
    expect((await h.http().post("/sync/push").set("Authorization", `Bearer ${s.ownerTok}`).send({})).status).toBe(401);
    expect((await h.http().get("/sync/pull")).status).toBe(401);
    expect((await s.push([])).status).toBe(400);
    await s.owner.post(`/devices/${s.device.id}/revoke`);
    expect((await s.push([s.adjust(s.v[0]!.id, -1)])).status).toBe(401);
  });
  it("sync exceptions are listed for managers with audit access and can be resolved (audited)", async () => {
    const s = await syncWorld();
    await s.push([s.adjust(s.v[0]!.id, -1)], new Date(Date.now() + 10 * 60_000).toISOString());
    const open = (await s.owner.get("/sync/exceptions")).body;
    expect(open).toHaveLength(1); expect(open[0]).toMatchObject({ kind: "skewed_clock", status: "open", deviceId: s.device.id });
    expect((await s.owner.post(`/sync/exceptions/${open[0].id}/resolve`)).status).toBe(204);
    expect((await s.owner.get("/sync/exceptions")).body).toHaveLength(0);
    expect((await s.owner.get("/sync/exceptions?status=resolved")).body).toHaveLength(1);
    expect((await s.owner.get("/audit?action=sync.exception_resolved")).body).toHaveLength(1);
  });
});

describe("snapshot and pull", () => {
  it("the snapshot has the catalogue and this location's stock only, without cost, and a cursor", async () => {
    const s = await syncWorld();
    const first = (await s.posGet("/sync/snapshot")).body;
    expect(first.cursor).toMatch(/^\d+:-1$/);
    let items = [...first.items]; let next = first.next;
    while (next) { const page = (await s.posGet(`/sync/snapshot?after=${encodeURIComponent(next)}`)).body; expect(page.cursor).toBeNull(); items = items.concat(page.items); next = page.next; }
    const of = (t: string) => items.filter((i) => i.type === t);
    expect(of("location")).toMatchObject([{ id: s.fitzroy.id, data: { name: "Fitzroy" } }]);
    expect(of("register").map((r) => r.id)).toEqual([s.register.id]);
    expect(of("variant")).toHaveLength(2); expect(of("product")).toHaveLength(1); expect(of("tax_class")).toHaveLength(2); expect(of("tax_rate")).toHaveLength(2);
    expect(of("stock_balance")).toMatchObject([{ id: `${s.v[0]!.id}:${s.fitzroy.id}`, data: { onHand: 10 } }]);   // not South Yarra's 5
    expect(JSON.stringify(items)).not.toContain("costMinor"); expect(JSON.stringify(items)).not.toContain("11840");
  });
  it("pull returns only what changed since the cursor, coalesced; then nothing; deletes come as tombstones", async () => {
    const s = await syncWorld();
    const snap = (await s.posGet("/sync/snapshot")).body; let cursor: string = snap.cursor;
    const drain = async () => { const r = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body; cursor = r.cursor; return r; };
    await drain();                                               // everything before the snapshot cursor is a no-op or a harmless repeat
    await s.hqApi.patch(`/variants/${s.v[0]!.id}`, { basePriceMinor: 22995 }); await s.hqApi.patch(`/variants/${s.v[0]!.id}`, { basePriceMinor: 23995 });
    expect((await s.push([s.adjust(s.v[0]!.id, -4)])).body.results[0].status).toBe("accepted");
    const r = await drain();
    const v = r.items.find((i: { type: string; id: string }) => i.type === "variant" && i.id === s.v[0]!.id);
    expect(v).toMatchObject({ op: "upsert", data: { basePriceMinor: 23995 } });                              // two edits, one item, latest state
    expect(r.items.filter((i: { type: string }) => i.type === "variant")).toHaveLength(1);
    expect(r.items.find((i: { type: string }) => i.type === "stock_balance")).toMatchObject({ id: `${s.v[0]!.id}:${s.fitzroy.id}`, data: { onHand: 6 } });
    expect((await drain()).items).toEqual([]);                    // nothing new
    await h.db.execute(sql`delete from shelfline.variant where id = ${s.v[1]!.id}`);
    expect((await drain()).items).toEqual([{ type: "variant", id: s.v[1]!.id, op: "delete" }]);
  });
  it("another location's stock changes never reach this device", async () => {
    const s = await syncWorld();
    const snap = (await s.posGet("/sync/snapshot")).body; const cursor = snap.cursor as string;
    await s.rec(s.southYarra.id, s.v[0]!.id, 9);
    const r = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body;
    expect(r.items.filter((i: { type: string }) => i.type === "stock_balance")).toEqual([]);
  });
  it("paging with a small limit reaches the same result; bad cursors are 400", async () => {
    const s = await syncWorld();
    for (let i = 0; i < 6; i++) await s.hqApi.post("/categories", { name: `Cat ${i}` });
    let cursor = "0:0"; const seen = new Set<string>(); let pages = 0;
    for (;;) { const r = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=4`)).body; pages++; r.items.forEach((i: { type: string; id: string }) => seen.add(`${i.type}|${i.id}`)); cursor = r.cursor; if (!r.hasMore) break; expect(pages).toBeLessThan(50); }
    expect(pages).toBeGreaterThan(1);
    expect([...seen].filter((k) => k.startsWith("category|"))).toHaveLength(7);
    expect((await s.posGet("/sync/pull?cursor=abc")).status).toBe(400);
  });

  it("V17b: while an OLDER transaction is still open, a newer committed change is held back so the cursor can never pass the older one", async () => {
    const s = await syncWorld();
    const snap = (await s.posGet("/sync/snapshot")).body; let cursor: string = snap.cursor;
    const url = "postgres://shelfline:shelfline@localhost:54340/shelfline_test";
    const t0 = new pg.Client({ connectionString: url }), t3 = new pg.Client({ connectionString: url });
    await t0.connect(); await t3.connect();
    const names = (r: { items: { type: string; data?: { name: string } }[] }) => r.items.filter((i) => i.type === "category").map((i) => i.data!.name);
    try {
      await t0.query("begin"); await t0.query("select pg_current_xact_id()");                          // the older transaction (lower id) stays open
      await t3.query("begin"); await t3.query(`insert into shelfline.category (org_id, name) values ('${s.orgId}', 'newer, committed first')`); await t3.query("commit");
      const r1 = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body; cursor = r1.cursor;
      await t0.query(`insert into shelfline.category (org_id, name) values ('${s.orgId}', 'older, committed last')`); await t0.query("commit");
      const r2 = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body;
      const all = [...names(r1), ...names(r2)];
      expect(all).toContain("older, committed last"); expect(all).toContain("newer, committed first");
      expect(names(r1)).not.toContain("newer, committed first");                                           // held back while the older transaction was open
    } finally { await t0.end(); await t3.end(); }
  });

  it("V17: a transaction that started earlier but commits later is never skipped (cursor is (txid, seq), horizon is pg_snapshot_xmin)", async () => {
    const s = await syncWorld();
    const snap = (await s.posGet("/sync/snapshot")).body; let cursor: string = snap.cursor;
    const url = "postgres://shelfline:shelfline@localhost:54340/shelfline_test";
    const t1 = new pg.Client({ connectionString: url }), t2 = new pg.Client({ connectionString: url });
    await t1.connect(); await t2.connect();
    try {
      await t2.query("begin"); await t2.query("select pg_current_xact_id()");   // T2 takes the LOWER transaction id...
      await t1.query("begin"); await t1.query(`insert into shelfline.category (org_id, name) values ('${s.orgId}', 'written by T1')`); // ...T1 takes the HIGHER id but the LOWER change_log seq
      await t2.query(`insert into shelfline.category (org_id, name) values ('${s.orgId}', 'written by T2')`);     // T2 gets the higher seq
      await t2.query("commit");                                                  // T2 commits first; T1 is still open
      const r1 = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body; cursor = r1.cursor;
      const names1 = r1.items.filter((i: { type: string }) => i.type === "category").map((i: { data: { name: string } }) => i.data.name);
      expect(names1).toContain("written by T2"); expect(names1).not.toContain("written by T1");   // T1 is invisible: it has not committed
      await t1.query("commit");
      const r2 = (await s.posGet(`/sync/pull?cursor=${encodeURIComponent(cursor)}`)).body;
      const names2 = r2.items.filter((i: { type: string }) => i.type === "category").map((i: { data: { name: string } }) => i.data.name);
      expect(names2).toContain("written by T1");                                  // a seq-only cursor would have skipped it forever
    } finally { await t1.end(); await t2.end(); }
  });
});
