import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { signature } from "../src/terminals/terminals.service";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let c: Awaited<ReturnType<typeof catalogWorld>>; let bridgeId: string; let secret: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); c = await catalogWorld(h);
  const b = (await c.owner.post("/bridges", { locationId: c.fitzroy.id, name: "Fitzroy back office" })).body; const p = (await h.http().post("/devices/pair").send({ pairingCode: b.pairingCode })).body; bridgeId = p.bridgeId; secret = p.secret;
  expect((await c.owner.post("/terminals", { locationId: c.fitzroy.id, serial: "CGRC000001", name: "Staff door" })).status).toBe(201);
});
const when = (min: number) => new Date(Date.UTC(2026, 10, 3, 22, 0) + min * 60_000).toISOString();          // 09:00 Melbourne on 4 Nov 2026, plus minutes
const ev = (o: object = {}) => ({ serial: "CGRC000001", personCode: "117", ts: when(0), verify: "fingerprint", ...o });
/** Send a batch the way the bridge does: sign `<unix seconds>.<exact body>`. */
const send = (events: object[], o: { id?: string; secret?: string; ts?: number; tamper?: boolean } = {}) => {
  const body = JSON.stringify({ events }); const ts = String(o.ts ?? Math.floor(Date.now() / 1000)); const sig = signature(o.secret ?? secret, ts, body);
  return h.http().post("/devices/punches").set("content-type", "application/json").set("x-bridge-id", o.id ?? bridgeId).set("x-timestamp", ts).set("x-signature", sig).send(o.tamper ? JSON.stringify({ events: [...events, ev({ personCode: "999" })] }) : body);
};
const punches = async () => (await h.db.execute(sql`select kind, method, client_ts, supersedes_id from shelfline.punch order by client_ts, received_at`)).rows as any[];

describe("pairing and signatures", () => {
  it("a pairing code is single use and short-lived; the secret is derived, never stored; a revoked bridge is shut out", async () => {
    const b = (await c.owner.post("/bridges", { locationId: c.fitzroy.id, name: "Second" })).body; expect(b.pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await h.http().post("/devices/pair").send({ pairingCode: "ZZZZ-ZZZZ" })).status).toBe(400); const ok = await h.http().post("/devices/pair").send({ pairingCode: b.pairingCode.toLowerCase() }); expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ bridgeId: b.id, location: "Fitzroy", timezone: "Australia/Melbourne" });
    expect((await h.http().post("/devices/pair").send({ pairingCode: b.pairingCode })).status).toBe(400);
    const late = (await c.owner.post("/bridges", { locationId: c.fitzroy.id, name: "Late" })).body; await h.db.execute(sql`update shelfline.bridge set pairing_expires_at = now() - interval '1 minute' where id = ${late.id}`); expect((await h.http().post("/devices/pair").send({ pairingCode: late.pairingCode })).status).toBe(400);
    expect(JSON.stringify((await h.db.execute(sql`select * from shelfline.bridge`)).rows)).not.toContain(secret);
    expect((await send([ev()])).status).toBe(200); expect((await c.owner.post(`/bridges/${bridgeId}/revoke`)).status).toBe(200); expect((await send([ev({ ts: when(1) })])).status).toBe(401);
    expect((await c.owner.post(`/bridges/${bridgeId}/pairing`)).body.pairingCode).toMatch(/^[A-Z2-9]{4}-/); expect((await c.mgr.post("/bridges", { locationId: c.southYarra.id, name: "x" })).status).toBe(403);
  });
  it("an unsigned, wrongly signed, stale or altered request is refused and changes nothing", async () => {
    expect((await h.http().post("/devices/punches").send({ events: [ev()] })).status).toBe(401);
    expect((await send([ev()], { secret: "0".repeat(64) })).status).toBe(401); expect((await send([ev()], { id: "11111111-1111-4111-8111-111111111111" })).status).toBe(401);
    expect((await send([ev()], { ts: Math.floor(Date.now() / 1000) - 3600 })).body).toMatchObject({ code: "bridge_stale_request" }); expect((await send([ev()], { tamper: true })).status).toBe(401);
    expect(await punches()).toEqual([]); expect((await send([ev(), ev({ state: "sideways" })])).status).toBe(400);                                  // bad content is refused whole
    expect((await send([ev()])).body.results).toEqual([{ status: "accepted" }]);
  });
});

describe("turning terminal records into punches", () => {
  it("the same record sent three times is one punch; the next different time alternates in and out", async () => {
    for (let i = 0; i < 3; i++) { const r = (await send([ev()])).body.results[0]; expect(r.status).toBe(i === 0 ? "accepted" : "duplicate"); }
    expect(await punches()).toMatchObject([{ kind: "in", method: "terminal_fp" }]); await send([ev({ ts: when(480) })]); await send([ev({ ts: when(1000) })]);
    expect((await punches()).map((p) => p.kind)).toEqual(["in", "out", "in"]); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.terminal_event`)).rows[0]).toMatchObject({ n: 3 });
  });
  it("records that arrive late and out of order still land in the right place: direction follows the person's punches before that moment", async () => {
    await send([ev({ ts: when(0) })]); await send([ev({ ts: when(600) })]); const r = await send([ev({ ts: when(300) })]);                                    // 14:00, sent after 19:00 was already in
    expect(r.body.results[0].status).toBe("accepted"); expect((await punches()).map((p) => [p.kind, new Date(p.client_ts).toISOString()])).toEqual([["in", when(0)], ["out", when(300)], ["out", when(600)]]);
  });
  it("a terminal that states the direction is believed; the person code may be the staff code or a separate terminal code", async () => {
    await send([ev({ state: "out" })]); expect((await punches())[0]).toMatchObject({ kind: "out" });
    const dan = (await c.owner.post("/users", { email: "dan@kestrel.test", name: "Dan", employeeCode: "220", pin: "5566", assignments: [{ role: "cashier", locationId: c.fitzroy.id }] })).body;
    expect((await c.owner.put(`/users/${dan.id}/terminal-code`, { code: "9001" })).status).toBe(200); expect((await send([ev({ personCode: "9001", ts: when(5) })])).body.results[0].status).toBe("accepted");
    expect((await send([ev({ personCode: "220", ts: when(7) })])).body.results[0]).toEqual({ status: "needs_review", reason: "unknown_person" });                       // once a terminal code is set, the staff code no longer points at him
    expect((await c.owner.put(`/users/${dan.id}/terminal-code`, { code: "117" })).status).toBe(409); expect((await send([ev({ personCode: "117", ts: when(6) })])).body.results[0].status).toBe("accepted");
    const owners = (await h.db.execute(sql`select distinct user_id from shelfline.punch`)).rows.length; expect(owners).toBe(2);
  });
  it("a disabled person's code is no longer honoured", async () => {
    const dan = (await c.owner.post("/users", { email: "gone@kestrel.test", name: "Gone", employeeCode: "330", pin: "1212", assignments: [{ role: "cashier", locationId: c.fitzroy.id }] })).body;
    expect((await send([ev({ personCode: "330" })])).body.results[0].status).toBe("accepted"); expect((await c.owner.post(`/users/${dan.id}/disable`)).status).toBe(204);
    expect((await send([ev({ personCode: "330", ts: when(30) })])).body.results[0]).toEqual({ status: "needs_review", reason: "unknown_person" });
  });
  it("an unknown person, an unregistered or revoked terminal, or a terminal at another store is held for review and makes no punch", async () => {
    await c.owner.post("/terminals", { locationId: c.southYarra.id, serial: "CGRC000002", name: "Other door" });
    const r = (await send([ev({ personCode: "555" }), ev({ serial: "NOPE123456", ts: when(1) }), ev({ serial: "CGRC000002", ts: when(2) })])).body.results;
    expect(r).toEqual([{ status: "needs_review", reason: "unknown_person" }, { status: "needs_review", reason: "unknown_terminal" }, { status: "needs_review", reason: "terminal_elsewhere" }]); expect(await punches()).toEqual([]);
    const t = (await c.owner.get("/terminals")).body.terminals.find((x: any) => x.serial === "CGRC000001"); await c.owner.post(`/terminals/${t.id}/revoke`); expect((await send([ev({ ts: when(3) })])).body.results[0]).toEqual({ status: "needs_review", reason: "unknown_terminal" });
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.terminal_event where status = 'needs_review'`)).rows[0]).toMatchObject({ n: 4 });
  });
});

describe("review, status and the timesheet", () => {
  it("a manager matches an unknown record to a person (one punch, audited) or dismisses it; another store's manager cannot", async () => {
    const r = await send([ev({ personCode: "555" }), ev({ personCode: "556", ts: when(1) })]); expect(r.status).toBe(200); const list = (await c.mgr.get(`/terminal-events?locationId=${c.fitzroy.id}`)).body; expect(list).toHaveLength(2); expect(list[0]).toMatchObject({ reason: "unknown_person", serial: "CGRC000001" });
    const a = list.find((x: any) => x.personCode === "555"), b = list.find((x: any) => x.personCode === "556");
    expect((await c.mgr.post(`/terminal-events/${a.id}/resolve`, { userId: c.cashier.id })).status).toBe(200); expect(await punches()).toMatchObject([{ kind: "in", method: "terminal_fp" }]); expect((await c.mgr.post(`/terminal-events/${a.id}/resolve`, { userId: c.cashier.id })).status).toBe(409);
    expect((await c.mgr.post(`/terminal-events/${b.id}/dismiss`)).body.status).toBe("dismissed"); expect((await c.mgr.get(`/terminal-events?locationId=${c.fitzroy.id}`)).body).toEqual([]); expect((await c.owner.get("/audit?action=terminal_event.resolve")).body.length).toBe(1);
    const other = (await c.owner.post("/users", { email: "sy5@kestrel.test", name: "Sy", password: "south-yarra-pass-5", assignments: [{ role: "store_manager", locationId: c.southYarra.id }] })).body; expect(other.id).toBeTruthy();
    const sy = c.as((await c.login("sy5@kestrel.test", "south-yarra-pass-5")).body.token); expect((await sy.get(`/terminal-events?locationId=${c.fitzroy.id}`)).status).toBe(403);
  });
  it("the till and the back office see who is clocked in, wherever the punch came from; and the punches become timesheet entries", async () => {
    const till = async () => { const d = c.as((await h.http().post("/pos/pin").set("x-device-key", c.device.key).send({ employeeCode: "117", pin: "4821" })).body.token); return (await d.get(`/punches/status?locationId=${c.fitzroy.id}`)).body; };
    expect(await till()).toMatchObject({ state: null }); await send([ev({ ts: new Date(Date.now() - 3 * 3_600_000).toISOString() })]); expect(await till()).toMatchObject({ state: "in", method: "terminal_fp", terminal: "Staff door" });
    await send([ev({ ts: new Date(Date.now() - 3_600_000).toISOString() })]); expect(await till()).toMatchObject({ state: "out" });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(new Date(Date.now() - 3 * 3_600_000)); const wide = (d: number) => new Date(Date.parse(day + "T12:00:00Z") + d * 86_400_000).toISOString().slice(0, 10); const t = (await c.mgr.get(`/timesheets?locationId=${c.fitzroy.id}&from=${wide(-1)}&to=${wide(1)}`)).body; expect(t.entries).toHaveLength(1); expect(t.entries[0]).toMatchObject({ user: "Priya N.", workedMinutes: 120 });
  });
  it("the list of bridges and terminals shows when each was last heard from", async () => {
    await send([ev()]); const l = (await c.owner.get("/terminals")).body; expect(l.bridges[0]).toMatchObject({ name: "Fitzroy back office", status: "active", lastBatchSize: 1 }); expect(l.bridges[0].lastSeenAt).toBeTruthy(); expect(l.terminals[0]).toMatchObject({ serial: "CGRC000001", eventsWeek: 1 }); expect((await c.mgr.get("/terminals")).status).toBe(403);
  });
});
