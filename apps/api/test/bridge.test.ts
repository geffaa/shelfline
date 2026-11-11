import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

/**
 * The real Go bridge and the terminal simulator against the real API: pairing, an outage of the connection, ordering, duplicates, an unknown person.
 * Skipped where Go is not installed.
 */
const hasGo = (() => { try { execFileSync("go", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const bridgeDir = path.resolve(__dirname, "../../bridge");
let h: Harness; let tmp: string; let bridgeBin: string; let simBin: string; let proc: ChildProcess | null = null;
beforeAll(async () => {
  if (!hasGo) return; h = await startApp(); tmp = mkdtempSync(path.join(tmpdir(), "bridge-"));
  bridgeBin = path.join(tmp, "bridge"); simBin = path.join(tmp, "termsim");
  execFileSync("go", ["build", "-o", bridgeBin, "./cmd/bridge"], { cwd: bridgeDir }); execFileSync("go", ["build", "-o", simBin, "./cmd/termsim"], { cwd: bridgeDir });
}, 120_000);
afterAll(async () => { proc?.kill(); if (hasGo) { await h.close(); rmSync(tmp, { recursive: true, force: true }); } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => Promise<boolean>, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return; await sleep(150); } throw new Error("timed out"); };
const sim = (port: number, args: string[]) => execFileSync(simBin, ["--bridge", `http://127.0.0.1:${port}`, ...args], { encoding: "utf8" });
const status = async (port: number) => (await fetch(`http://127.0.0.1:${port}/status`)).json() as Promise<{ paired: boolean; queued: number; sent: number; accepted: number; duplicates: number; needsReview: number; terminals: number; lastError: string }>;
const punches = async () => (await h.db.execute(sql`select kind, method, client_ts from shelfline.punch order by client_ts`)).rows as { kind: string; method: string; client_ts: Date }[];

describe.skipIf(!hasGo)("Go bridge and terminal simulator against the API", () => {
  it("pairs, queues through a connection outage in order, forwards on return, collapses repeats, and holds an unknown person for review", async () => {
    await reset(h); const c = await catalogWorld(h); const server = h.app.getHttpServer() as Server; await h.app.listen(0, "127.0.0.1"); const apiPort = (server.address() as { port: number }).port; const apiUrl = `http://127.0.0.1:${apiPort}`;
    await c.owner.post("/terminals", { locationId: c.fitzroy.id, serial: "CGRC000001", name: "Staff door" }); const br = (await c.owner.post("/bridges", { locationId: c.fitzroy.id, name: "Back office" })).body;
    const port = 18230 + Math.floor(Math.random() * 500);
    proc = spawn(bridgeBin, ["--data", path.join(tmp, "data"), "--server", apiUrl, "--pair", br.pairingCode, "--listen", `127.0.0.1:${port}`, "--interval", "300ms"], { stdio: "ignore" });
    await until(async () => { try { return (await status(port)).paired; } catch { return false; } });
    expect((await h.db.execute(sql`select status from shelfline.bridge`)).rows[0]).toMatchObject({ status: "active" });

    // the connection to Shelfline goes away; the terminal keeps pushing to the bridge, which keeps everything
    await new Promise<void>((r) => server.close(() => r()));
    sim(port, ["--person", "117", "--at", "2026-11-04 09:00:00", "--verify", "1"]); sim(port, ["--person", "117", "--at", "2026-11-04 12:00:00", "--verify", "1"]);
    sim(port, ["--person", "117", "--at", "2026-11-04 12:30:00", "--verify", "15", "--repeat", "3"]); sim(port, ["--person", "117", "--at", "2026-11-04 17:30:00"]); sim(port, ["--person", "555", "--at", "2026-11-04 09:05:00"]);
    await sleep(1200); const down = await status(port); expect(down.queued).toBe(7); expect(down.lastError).not.toBe(""); expect(down.terminals).toBe(1);
    expect(await punches()).toEqual([]);

    // and comes back: the bridge backs off while it was down, then catches up
    await new Promise<void>((r) => server.listen(apiPort, "127.0.0.1", () => r()));
    await until(async () => (await status(port)).queued === 0, 45_000);
    const s = await status(port); expect(s).toMatchObject({ queued: 0, sent: 7, accepted: 4, duplicates: 2, needsReview: 1 });
    const ps = await punches(); expect(ps.map((p) => p.kind)).toEqual(["in", "out", "in", "out"]); expect(ps.every((p) => p.method === "terminal_fp")).toBe(true);
    expect(ps.map((p) => new Date(p.client_ts).toISOString())).toEqual(["2026-11-03T22:00:00.000Z", "2026-11-04T01:00:00.000Z", "2026-11-04T01:30:00.000Z", "2026-11-04T06:30:00.000Z"]);          // Melbourne wall clock, +11
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.terminal_event where status = 'needs_review' and person_code = '555'`)).rows[0]).toMatchObject({ n: 1 });
    expect((await c.mgr.get(`/terminal-events?locationId=${c.fitzroy.id}`)).body).toMatchObject([{ personCode: "555", reason: "unknown_person" }]);
    expect((await c.mgr.get(`/timesheets?locationId=${c.fitzroy.id}&from=2026-11-04&to=2026-11-04`)).body.entries).toMatchObject([{ user: "Priya N.", workedMinutes: 180 }, { user: "Priya N.", workedMinutes: 300 }]);
  }, 120_000);
});
