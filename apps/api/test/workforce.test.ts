import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { zonedInstant } from "../src/common/business-day";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); w = await posWorld(h, { stock: 5 }); });
const TZ = "Australia/Melbourne"; const at = (date: string, hm: string) => new Date(zonedInstant(date, hm, TZ)).toISOString();
const shiftOf = (o: object = {}) => w.mgr.post("/shifts", { locationId: w.fitzroy.id, userId: w.cashier.id, date: "2026-11-04", start: "09:00", end: "17:00", breakMinutes: 30, role: "Floor", ...o });
const publish = (from = "2026-11-01", to = "2026-11-30") => w.mgr.post("/shifts/publish", { locationId: w.fitzroy.id, from, to });
/** A punch the way the till sends it, at a chosen moment. */
const punchAt = async (kind: "in" | "out", iso: string) => { const c = { ...w.cmd("punch.record", { punchId: randomUUID(), kind, method: "pin" }), clientTs: iso }; const r = await w.push([c]); expect(r.status).toBe(200); return r.body.results[0] as { status: string; flags?: string[]; result?: { punchId: string } }; };
const sheet = async (from = "2026-11-01", to = "2026-11-30", api = w.mgr) => (await api.get(`/timesheets?locationId=${w.fitzroy.id}&from=${from}&to=${to}`)).body;

describe("shifts", () => {
  it("are rostered for an assigned person in the location's own time; an overnight shift runs into the next day; the same person cannot be in two places at once", async () => {
    const r = await shiftOf(); expect(r.status, JSON.stringify(r.body)).toBe(201); expect(new Date(r.body.startsAt).toISOString()).toBe(at("2026-11-04", "09:00")); expect(new Date(r.body.endsAt).toISOString()).toBe(at("2026-11-04", "17:00"));
    expect((await shiftOf({ start: "16:00", end: "20:00" })).body).toMatchObject({ code: "shift_overlap", conflictId: r.body.id }); expect((await shiftOf({ start: "17:00", end: "20:00" })).status).toBe(201);               // back to back is fine
    const night = await shiftOf({ date: "2026-11-05", start: "22:00", end: "06:00" }); expect(new Date(night.body.endsAt).toISOString()).toBe(at("2026-11-06", "06:00")); expect(night.body.localDate).toBe("2026-11-05");
    expect((await shiftOf({ date: "2026-11-06", start: "05:00", end: "09:00" })).body.code).toBe("shift_overlap");
    expect((await shiftOf({ start: "09:00", end: "09:00", date: "2026-11-10" })).status).toBe(400); expect((await shiftOf({ userId: w.hq.id, date: "2026-11-10" })).status).toBe(201);         // an org-wide manager may be rostered anywhere
    expect((await shiftOf({ userId: w.mgr ? w.manager.id : undefined, date: "2026-11-11" })).status).toBe(201); expect((await shiftOf({ userId: randomUUID(), date: "2026-11-12" })).status).toBe(404);
    const open = await shiftOf({ userId: null, date: "2026-11-13" }); expect(open.status).toBe(201); expect(open.body.userId).toBeNull();
  });
  it("can be changed and removed; draft shifts are invisible to the person until published; only roster managers of that place may write", async () => {
    const s = (await shiftOf()).body; expect((await w.mgr.get(`/shifts?locationId=${w.fitzroy.id}&from=2026-11-04&to=2026-11-04`)).body.shifts[0]).toMatchObject({ id: s.id, published: false, user: "Priya N." });
    const till0 = null; void till0;
    const till = (path: string) => h.http().get(path).set("Authorization", `Bearer ${w.tok}`); expect((await till("/shifts/mine?from=2026-11-01&to=2026-11-30")).body).toEqual([]);   // a draft is not on the till
    expect((await publish()).body).toEqual({ published: 1 }); expect((await till("/shifts/mine?from=2026-11-01&to=2026-11-30")).body).toMatchObject([{ id: s.id, date: "2026-11-04" }]); expect((await publish()).body).toEqual({ published: 0 });
    expect((await w.mgr.patch(`/shifts/${s.id}`, { start: "10:00", end: "18:00" })).body).toMatchObject({ localDate: "2026-11-04" }); expect(new Date((await w.mgr.get(`/shifts?locationId=${w.fitzroy.id}&from=2026-11-04&to=2026-11-04`)).body.shifts[0].startsAt).toISOString()).toBe(at("2026-11-04", "10:00"));
    expect((await w.mgr.patch(`/shifts/${s.id}`, { userId: null })).body.userId).toBeNull(); expect((await w.mgr.delete(`/shifts/${s.id}`)).status).toBe(204); expect((await w.mgr.delete(`/shifts/${s.id}`)).status).toBe(404);
    const other = (await w.owner.post("/users", { email: "sy3@kestrel.test", name: "Sy", password: "south-yarra-pass-3", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] })).body; expect(other.id).toBeTruthy();
    const sy = w.as((await w.login("sy3@kestrel.test", "south-yarra-pass-3")).body.token); expect((await sy.post("/shifts", { locationId: w.fitzroy.id, date: "2026-11-04", start: "09:00", end: "17:00" })).status).toBe(403); expect((await sy.get(`/shifts?locationId=${w.fitzroy.id}&from=2026-11-01&to=2026-11-30`)).status).toBe(403);
    expect((await w.owner.get("/audit?action=shift.publish")).body.length).toBeGreaterThan(0);
  });
  it("a person sees only their own published shifts", async () => {
    await shiftOf(); await shiftOf({ date: "2026-11-05" }); await w.mgr.post("/shifts", { locationId: w.fitzroy.id, userId: w.manager.id, date: "2026-11-04", start: "09:00", end: "17:00" }); await publish("2026-11-04", "2026-11-04");
    const mine = (await w.mgr.get("/shifts/mine?from=2026-11-01&to=2026-11-30")).body; expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ date: "2026-11-04", location: "Fitzroy", timezone: TZ });
  });
  it("templates are applied over dates and people, skipping what would clash; the board shows days below the staffing need and open shifts", async () => {
    const t = (await w.mgr.post("/shift-templates", { name: "Open", startTime: "09:00", endTime: "17:00", breakMinutes: 30, role: "Floor" })).body; expect((await w.mgr.post("/shift-templates", { name: "OPEN", startTime: "08:00", endTime: "12:00" })).status).toBe(409);
    await shiftOf({ date: "2026-11-06", start: "12:00", end: "14:00" });
    const r = (await w.mgr.post("/shifts/apply", { locationId: w.fitzroy.id, templateId: t.id, dates: ["2026-11-05", "2026-11-06", "2026-11-07"], userIds: [w.cashier.id] })).body; expect(r.created).toBe(2); expect(r.skipped).toEqual([{ date: "2026-11-06", userId: w.cashier.id, reason: "shift_overlap" }]);
    expect((await w.mgr.post("/shifts/apply", { locationId: w.fitzroy.id, templateId: t.id, dates: ["2026-11-08"], userIds: [] })).body.created).toBe(1);
    expect((await w.mgr.put(`/locations/${w.fitzroy.id}/staffing`, { 5: 2, 6: 1 })).status).toBe(200); expect((await w.mgr.get(`/locations/${w.fitzroy.id}/staffing`)).body).toEqual({ 5: 2, 6: 1 });
    const board = (await w.mgr.get(`/shifts?locationId=${w.fitzroy.id}&from=2026-11-05&to=2026-11-08`)).body.days; const day = (d: string) => board.find((x: any) => x.date === d);
    expect(day("2026-11-06")).toMatchObject({ weekday: 5, need: 2, staffed: 1, under: true }); expect(day("2026-11-07")).toMatchObject({ weekday: 6, need: 1, staffed: 1, under: false }); expect(day("2026-11-08")).toMatchObject({ staffed: 0, open: 1, need: 0, under: false });
  });
});

describe("timesheets", () => {
  it("a clock-in at 09:12 for a 09:00 shift is 12 minutes late, and the entry compares worked time with the schedule", async () => {
    await shiftOf(); await publish(); await punchAt("in", at("2026-11-04", "09:12")); await punchAt("out", at("2026-11-04", "17:00"));
    const t = await sheet(); expect(t.entries).toHaveLength(1); expect(t.entries[0]).toMatchObject({ user: "Priya N.", date: "2026-11-04", lateMinutes: 12, breakMinutes: 30, workedMinutes: 438, scheduledMinutes: 450, varianceMinutes: -12, status: "open", flags: ["late"] });
    expect(t.people[0]).toMatchObject({ workedMinutes: 438, scheduledMinutes: 450, lateMinutes: 12 }); expect((await sheet()).entries).toHaveLength(1);                           // asking again changes nothing
  });
  it("a forgotten clock-out is flagged and cannot be approved; a manager's correction adds a new punch, the original stays, and then it can", async () => {
    await shiftOf(); await publish(); const inn = await punchAt("in", at("2026-11-04", "09:00")); await punchAt("in", at("2026-11-05", "09:00")); await punchAt("out", at("2026-11-05", "17:00"));
    let t = await sheet(); const e1 = t.entries.find((e: any) => e.date === "2026-11-04"); expect(e1).toMatchObject({ outAt: null, workedMinutes: null, flags: expect.arrayContaining(["missing_out"]) });
    expect((await w.mgr.post("/timesheets/approve", { ids: [e1.id] })).body).toEqual([{ id: e1.id, result: "incomplete" }]);
    const before = Number(((await h.db.execute(sql`select count(*)::int as n from shelfline.punch`)).rows[0] as any).n);
    const fix = await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "out", at: at("2026-11-04", "17:05"), reason: "Forgot to clock out, confirmed with Priya" }); expect(fix.status, JSON.stringify(fix.body)).toBe(201);
    expect(Number(((await h.db.execute(sql`select count(*)::int as n from shelfline.punch`)).rows[0] as any).n)).toBe(before + 1); expect((await h.db.execute(sql`select kind, method from shelfline.punch where id = ${inn.result!.punchId}`)).rows[0]).toMatchObject({ kind: "in", method: "pin" });
    t = await sheet(); const fixed = t.entries.find((e: any) => e.date === "2026-11-04"); expect(fixed).toMatchObject({ workedMinutes: 485 - 30, flags: [] });             // 09:00-17:05 less the 30 minute break
    expect((await w.mgr.post("/timesheets/approve", { ids: [fixed.id] })).body).toEqual([{ id: fixed.id, result: "approved" }]); expect((await w.mgr.post("/timesheets/approve", { ids: [fixed.id] })).body[0].result).toBe("already");
    expect((await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "out", at: at("2026-11-04", "17:30"), reason: "Another change" })).body).toMatchObject({ code: "day_approved", date: "2026-11-04" });
    expect((await sheet()).entries.find((e: any) => e.date === "2026-11-04")).toMatchObject({ status: "approved", workedMinutes: 455 });
    const a = (await w.owner.get("/audit?action=punch.correct")).body[0]; expect(a).toMatchObject({ action: "punch.correct" }); expect(JSON.stringify(a.detail)).toContain("Forgot to clock out");
  });
  it("a wrong punch is superseded by a new one, never edited; it cannot be corrected twice; the entry follows the new time", async () => {
    await shiftOf(); await publish(); const bad = await punchAt("in", at("2026-11-04", "11:40")); await punchAt("out", at("2026-11-04", "17:00"));
    expect((await sheet()).entries[0]).toMatchObject({ lateMinutes: 160 });
    const r = await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "in", at: at("2026-11-04", "09:05"), supersedesPunchId: bad.result!.punchId, reason: "Terminal was down, started 09:05" }); expect(r.status).toBe(201);
    expect((await sheet()).entries[0]).toMatchObject({ lateMinutes: 5, workedMinutes: 475 - 30 }); expect((await h.db.execute(sql`select client_ts from shelfline.punch where id = ${bad.result!.punchId}`)).rows).toHaveLength(1);
    expect((await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "in", at: at("2026-11-04", "09:10"), supersedesPunchId: bad.result!.punchId, reason: "Again" })).body.code).toBe("punch_already_corrected");
    expect((await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "in", at: at("2026-11-04", "09:10"), reason: "x" })).status).toBe(400);
    expect((await w.mgr.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "in", at: new Date(Date.now() + 86_400_000).toISOString(), reason: "future" })).status).toBe(400);
  });
  it("a night shift as the clocks go forward is seven real hours and belongs to the day it started; as they go back it is nine", async () => {
    await w.mgr.post("/shifts", { locationId: w.fitzroy.id, userId: w.cashier.id, date: "2026-10-03", start: "22:00", end: "06:00" }); await w.mgr.post("/shifts", { locationId: w.fitzroy.id, userId: w.cashier.id, date: "2026-04-04", start: "22:00", end: "06:00" }); await publish("2026-04-01", "2026-04-30"); await publish("2026-10-01", "2026-10-31");
    await punchAt("in", at("2026-10-03", "22:00")); await punchAt("out", at("2026-10-04", "06:00")); await punchAt("in", at("2026-04-04", "22:00")); await punchAt("out", at("2026-04-05", "06:00"));
    expect((await sheet("2026-10-01", "2026-10-31")).entries).toMatchObject([{ date: "2026-10-03", workedMinutes: 420, scheduledMinutes: 420, varianceMinutes: 0 }]); expect((await sheet("2026-04-01", "2026-04-30")).entries).toMatchObject([{ date: "2026-04-04", workedMinutes: 540, scheduledMinutes: 540 }]);
  });
  it("an unpublished shift is a plan, not a promise: it does not make a clock-in late; and only the place's own managers may correct or approve", async () => {
    await shiftOf(); await punchAt("in", at("2026-11-04", "09:30")); await punchAt("out", at("2026-11-04", "17:00"));
    expect((await sheet()).entries[0]).toMatchObject({ lateMinutes: 0, shiftId: null, flags: ["no_shift"] }); await publish(); expect((await sheet()).entries[0]).toMatchObject({ lateMinutes: 30, flags: ["late"] });
    await w.owner.post("/users", { email: "sy4@kestrel.test", name: "Sy", password: "south-yarra-pass-4", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] });
    const sy = w.as((await w.login("sy4@kestrel.test", "south-yarra-pass-4")).body.token); const id = (await sheet()).entries[0].id;
    expect((await sy.post("/timesheets/corrections", { userId: w.cashier.id, locationId: w.fitzroy.id, kind: "out", at: at("2026-11-04", "17:30"), reason: "Not mine" })).status).toBe(403); expect((await sy.post("/timesheets/approve", { ids: [id] })).body).toEqual([{ id, result: "forbidden" }]);
  });
  it("repeated punches are held for review and counted; an entry for a day with no shift says so; only people with timesheet rights may look", async () => {
    await punchAt("in", at("2026-11-04", "09:00")); const dup = await punchAt("in", at("2026-11-04", "09:01")); expect(dup.flags).toEqual(["punch_repeat"]); await punchAt("out", at("2026-11-04", "13:00"));
    const t = await sheet(); expect(t.needsReviewPunches).toBe(1); expect(t.entries.map((e: any) => e.flags)).toEqual([["missing_out", "no_shift"], ["no_shift"]]);
    expect((await w.owner.get(`/timesheets?locationId=${w.fitzroy.id}&from=2026-11-01&to=2026-11-30`)).status).toBe(200);
    expect((await w.hqApi.get(`/timesheets?locationId=${w.fitzroy.id}&from=2026-11-30&to=2026-11-01`)).status).toBe(400);
  });
});
