import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { priceCart } from "@shelfline/pricing";
import { decodeEscPos } from "../src/printing/escpos";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); w = await posWorld(h, { stock: 50 }); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 20000 })]); });

async function sell(lines: { v: number; qty: number }[] = [{ v: 0, qty: 1 }], tender: "cash" | "card" = "cash") {
  const ls = lines.map((l) => ({ variantId: w.v[l.v]!.id, qty: l.qty, unitPriceMinor: [21995, 8900, 3400][l.v]!, discountMinor: 0 })); const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const sale = { saleId, sessionId: session, receiptNo: `FIT-2-${saleId.slice(0, 6)}`, customerId: null, lines: ls, payments: [{ tender, amountMinor: p.payableMinor, ...(tender === "cash" ? { tenderedMinor: p.payableMinor + 500 } : {}) }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null };
  expect((await w.push([w.cmd("sale.create", sale)])).body.results[0].status).toBe("accepted"); return { saleId, receiptNo: sale.receiptNo, total: p.totalMinor };
}
const printer = async (o: object = {}) => { const r = await w.owner.post("/printers", { locationId: w.fitzroy.id, name: "Front desk", host: "192.168.1.50", ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string; port: number; columns: number }; };
const till = (b: object) => h.http().post("/pos/print").set("Authorization", `Bearer ${w.tok}`).send(b);
const jobs = async () => (await h.db.execute(sql`select id, kind, status, attempts, copy, payload_base64, last_error from shelfline.print_job order by created_at`)).rows as { id: string; kind: string; status: string; attempts: number; copy: number; payload_base64: string; last_error: string | null }[];
const printed = (b64: string) => decodeEscPos(Buffer.from(b64, "base64"));

describe("setting up printers", () => {
  it("anyone who may manage devices at the store can add one; hosts must be names or addresses, nothing else", async () => {
    const p = await printer(); expect(p).toMatchObject({ port: 9100, columns: 42 }); expect((await w.owner.post("/printers", { locationId: w.fitzroy.id, name: "Front desk", host: "10.0.0.2" })).status).toBe(409);
    for (const host of ["http://10.0.0.5/print", "10.0.0.5:9100", "999.1.1.1", "bad host", "", "a_b.local", "-x.local"]) expect([host, (await w.owner.post("/printers", { locationId: w.fitzroy.id, name: `P-${host.length}`, host })).status]).toEqual([host, 400]);
    for (const b of [{ port: 0 }, { port: 70000 }, { columns: 10 }, { columns: 99 }]) expect((await w.owner.post("/printers", { locationId: w.fitzroy.id, name: "X", host: "10.0.0.5", ...b })).status).toBe(400);
    expect((await w.owner.post("/printers", { locationId: w.fitzroy.id, name: "Y", host: "printer-1.store.local", port: 9101, columns: 32 })).status).toBe(201);
    expect((await w.mgr.get("/printers")).status).toBe(403); expect((await w.mgr.post("/printers", { locationId: w.fitzroy.id, name: "Z", host: "10.0.0.9" })).status).toBe(403);
    expect((await w.owner.patch(`/printers/${p.id}`, { host: "not a host" })).status).toBe(400); expect((await w.owner.patch(`/printers/${p.id}`, { active: false })).body.active).toBe(false);
    expect((await w.owner.get("/audit?action=printer.create")).body).toHaveLength(2);
  });
});

describe("the till asks for a receipt or the drawer", () => {
  it("prints the sale as it was rung up, and every further request is a copy marked COPY", async () => {
    await printer({ columns: 42 }); const s = await sell([{ v: 0, qty: 1 }, { v: 1, qty: 2 }]);
    const a = await till({ kind: "receipt", saleId: s.saleId }); expect(a.status).toBe(200); expect(a.body).toMatchObject({ printer: "Front desk", copy: 1 });
    const b = await till({ kind: "receipt", saleId: s.saleId }); expect(b.body.copy).toBe(2); const [j1, j2] = await jobs();
    const one = printed(j1!.payload_base64), two = printed(j2!.payload_base64); const text = one.lines.join("\n");
    expect(text).toContain("Kestrel Run Co."); expect(text).toContain("Fitzroy"); expect(text).toContain("Served by Priya N."); expect(text).toContain("1 x Tempra Glide 3"); expect(text).toContain("2 x Tempra Glide 3"); expect(text).toContain(`Receipt ${s.receiptNo}`);
    expect(one.lines.find((l) => l.startsWith("Cash"))).toMatch(/\d\.\d\d$/); expect(one.lines.find((l) => l.includes("Change"))).toMatch(/5\.00$/); expect(text).toContain((s.total / 100).toFixed(2)); expect(one.barcodes).toEqual([s.receiptNo]); expect(one.cuts).toBe(1);
    expect(text).not.toContain("COPY"); expect(two.lines.join("\n")).toContain("*** COPY 2 ***"); for (const l of one.lines) expect(l.length).toBeLessThanOrEqual(42);
  });
  it("opens the drawer, using the register's own printer when it has one and the store's shared one otherwise", async () => {
    const shared = await printer({ name: "Shared", host: "10.0.0.10" }); const own = await printer({ name: "Front desk only", host: "10.0.0.11", registerId: w.register.id });
    const r = await till({ kind: "drawer", reason: "no_sale" }); expect(r.body.printer).toBe("Front desk only"); await w.owner.patch(`/printers/${own.id}`, { active: false }); expect((await till({ kind: "drawer", reason: "cash_sale" })).body.printer).toBe("Shared"); void shared;
    const js = await jobs(); expect(js.map((j) => j.kind)).toEqual(["drawer", "drawer"]); expect(printed(js[0]!.payload_base64).drawerKicks).toBe(1);
  });
  it("says so when there is no printer, refuses another store's sale and unknown sales, and needs a till token", async () => {
    const s = await sell(); expect((await till({ kind: "receipt", saleId: s.saleId })).body).toMatchObject({ code: "no_printer" }); expect((await till({ kind: "drawer" })).status).toBe(409);
    await printer(); await h.db.execute(sql`update shelfline.sale set location_id = ${w.southYarra.id} where id = ${s.saleId}`); expect((await till({ kind: "receipt", saleId: s.saleId })).status).toBe(403); expect((await till({ kind: "receipt", saleId: randomUUID() })).status).toBe(404);
    expect((await till({ kind: "nope" })).status).toBe(400); expect((await w.owner.post("/pos/print", { kind: "drawer" })).status).toBe(401); expect((await h.http().post("/pos/print").send({ kind: "drawer" })).status).toBe(401);
  });
});

describe("what the bridge may do", () => {
  const sign = (secret: string, ts: string, body: string) => createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex");
  async function bridge(locationId = w.fitzroy.id) {
    const created = (await w.owner.post("/bridges", { locationId, name: "Back office" })).body; const paired = (await h.http().post("/devices/pair").send({ pairingCode: created.pairingCode })).body as { bridgeId: string; secret: string };
    const call = (path: string, body: object, o: { secret?: string; ts?: string } = {}) => { const raw = JSON.stringify(body); const ts = o.ts ?? String(Math.floor(Date.now() / 1000)); return h.http().post(path).set("content-type", "application/json").set("x-bridge-id", paired.bridgeId).set("x-timestamp", ts).set("x-signature", sign(o.secret ?? paired.secret, ts, raw)).send(raw); };
    return { ...paired, call, claim: (max = 5) => call("/devices/print-jobs/claim", { max }), report: (id: string, ok: boolean, error?: string) => call("/devices/print-jobs/result", { id, ok, ...(error ? { error } : {}) }) };
  }
  it("hands over only its own store's jobs, once, and a job nobody reports on goes back after a minute", async () => {
    const p = await printer(); const b = await bridge(); await till({ kind: "drawer" }); const mine = await b.claim(); expect(mine.status).toBe(200); expect(mine.body.jobs).toHaveLength(1);
    expect(mine.body.jobs[0]).toMatchObject({ kind: "drawer", host: "192.168.1.50", port: 9100, attempt: 1 }); expect((await b.claim()).body.jobs).toEqual([]);
    expect((await jobs())[0]).toMatchObject({ status: "sending", attempts: 1 });
    await h.db.execute(sql`update shelfline.print_job set claimed_at = now() - interval '2 minutes'`); const again = await b.claim(); expect(again.body.jobs).toHaveLength(1); expect(again.body.jobs[0].attempt).toBe(2);
    const other = await bridge(w.southYarra.id); expect((await other.claim()).body.jobs).toEqual([]); void p;
  });
  it("marks a printed job done and the printer healthy; a failure goes back to the queue twice and then stays failed until someone retries it", async () => {
    const p = await printer(); const b = await bridge(); await till({ kind: "drawer" });
    for (let i = 1; i <= 3; i++) { const j = (await b.claim()).body.jobs; expect(j).toHaveLength(1); expect((await b.report(j[0].id, false, "connect ECONNREFUSED")).body.status).toBe(i < 3 ? "queued" : "failed"); }
    expect((await b.claim()).body.jobs).toEqual([]); expect((await jobs())[0]).toMatchObject({ status: "failed", attempts: 3, last_error: "connect ECONNREFUSED" });
    const list = (await w.owner.get("/printers")).body[0]; expect(list).toMatchObject({ id: p.id, failed: 1, waiting: 0, lastError: "connect ECONNREFUSED" });
    const id = (await jobs())[0]!.id; expect((await w.owner.post(`/print-jobs/${id}/retry`)).status).toBe(200); expect((await w.owner.post(`/print-jobs/${id}/retry`)).status).toBe(409);
    const j = (await b.claim()).body.jobs; expect(j[0].attempt).toBe(1); expect((await b.report(j[0].id, true)).body.status).toBe("done"); expect((await b.report(j[0].id, true)).body.status).toBe("done");
    expect((await w.owner.get("/printers")).body[0]).toMatchObject({ failed: 0, waiting: 0, lastError: null }); expect((await w.owner.get("/printers")).body[0].lastOkAt).toBeTruthy();
    expect((await w.owner.get("/print-jobs")).body[0]).toMatchObject({ status: "done", kind: "drawer" });
  });
  it("refuses a request with the wrong key, a stale time, a revoked bridge, and cannot report on another store's job", async () => {
    await printer(); const b = await bridge(); await till({ kind: "drawer" }); const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await b.call("/devices/print-jobs/claim", { max: 1 }, { secret: "0".repeat(64) })).status).toBe(401); expect((await b.call("/devices/print-jobs/claim", { max: 1 }, { ts: stale })).status).toBe(401);
    expect((await h.http().post("/devices/print-jobs/claim").send({ max: 1 })).status).toBe(401); expect((await h.http().post("/devices/print-jobs/result").send({ id: randomUUID(), ok: true })).status).toBe(401);
    const id = (await jobs())[0]!.id; const other = await bridge(w.southYarra.id); expect((await other.report(id, true)).status).toBe(404);
    const rows = (await h.db.execute(sql`select id from shelfline.bridge where location_id = ${w.fitzroy.id}`)).rows; await w.owner.post(`/bridges/${rows[0]!.id}/revoke`); expect((await b.claim()).status).toBe(401);
  });
  it("a test print goes through the same queue", async () => {
    const p = await printer(); const r = await w.owner.post(`/printers/${p.id}/test`); expect(r.status).toBe(200); const j = (await jobs())[0]!; expect(j.kind).toBe("test"); expect(printed(j.payload_base64).lines.join("\n")).toContain("Shelfline test print");
  });
});

const hasGo = (() => { try { execFileSync("go", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!hasGo)("the real bridge and a virtual printer", () => {
  let tmp: string; const procs: ChildProcess[] = []; const bridgeDir = path.resolve(__dirname, "../../bridge");
  afterAll(() => { procs.forEach((p) => p.kill()); if (tmp) rmSync(tmp, { recursive: true, force: true }); });
  it("a receipt and a drawer kick requested at the till reach a printer on the network, byte for byte", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "print-")); const bridgeBin = path.join(tmp, "bridge"), vpBin = path.join(tmp, "vp");
    execFileSync("go", ["build", "-o", bridgeBin, "./cmd/bridge"], { cwd: bridgeDir }); execFileSync("go", ["build", "-o", vpBin, "./cmd/virtualprinter"], { cwd: bridgeDir });
    const base = 19100 + Math.floor(Math.random() * 400); const out: string[] = [];
    const vp = spawn(vpBin, ["--listen", `127.0.0.1:${base}`, "--web", `127.0.0.1:${base + 1}`], { stdio: ["ignore", "pipe", "ignore"] }); procs.push(vp); vp.stdout!.on("data", (d) => out.push(String(d)));
    await h.app.listen(0, "127.0.0.1"); const apiPort = (h.app.getHttpServer().address() as { port: number }).port;
    const p = await printer({ host: "127.0.0.1", port: base }); const s = await sell([{ v: 0, qty: 1 }]);
    const br = (await w.owner.post("/bridges", { locationId: w.fitzroy.id, name: "Back office" })).body;
    const bp = spawn(bridgeBin, ["--data", path.join(tmp, "data"), "--server", `http://127.0.0.1:${apiPort}`, "--pair", br.pairingCode, "--listen", `127.0.0.1:${base + 2}`, "--interval", "300ms"], { stdio: "ignore" }); procs.push(bp);
    expect((await till({ kind: "receipt", saleId: s.saleId })).status).toBe(200); expect((await till({ kind: "drawer", reason: "cash_sale" })).status).toBe(200);
    const t0 = Date.now(); while (Date.now() - t0 < 20_000 && (await jobs()).some((j) => j.status !== "done")) await new Promise((r) => setTimeout(r, 200));
    expect((await jobs()).map((j) => j.status)).toEqual(["done", "done"]); const text = out.join(""); expect(text).toContain(`Receipt ${s.receiptNo}`); expect(text).toContain("1 x Tempra Glide 3"); expect(text).toContain("1 cut"); expect(text).toContain("1 drawer");
    const page = await (await fetch(`http://127.0.0.1:${base + 1}/`)).text(); expect(page).toContain("drawer opened"); expect(page).toContain("Kestrel Run Co.");
    expect((await w.owner.get("/printers")).body.find((x: { id: string }) => x.id === p.id)).toMatchObject({ failed: 0, waiting: 0 }); expect((await w.owner.get("/printers")).body[0].lastOkAt).toBeTruthy();
    // the printer is switched off: the job is retried, then reported as failed, and nothing is lost
    vp.kill(); await new Promise((r) => setTimeout(r, 300)); await till({ kind: "drawer", reason: "manual" }); const t1 = Date.now(); while (Date.now() - t1 < 25_000 && (await jobs()).at(-1)!.status !== "failed") await new Promise((r) => setTimeout(r, 300));
    expect((await jobs()).at(-1)).toMatchObject({ status: "failed", attempts: 3 }); expect((await w.owner.get("/printers")).body[0].lastError).toMatch(/refused|ECONNREFUSED|connect/i);
  }, 120_000);
});
