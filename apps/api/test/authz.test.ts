import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "../src/audit/audit.service";
import { sql } from "drizzle-orm";
import { reset, startApp, world, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

describe("location-scoped authorisation", () => {
  it("a Fitzroy store manager sees Fitzroy only; South Yarra is 403 and the denial is audited", async () => {
    const w = await world(h);
    const list = await w.mgr.get("/locations");
    expect(list.body.map((l: { name: string }) => l.name)).toEqual(["Fitzroy"]);
    expect((await w.mgr.get(`/locations/${w.fitzroy.id}`)).status).toBe(200);
    expect((await w.mgr.get(`/locations/${w.southYarra.id}`)).status).toBe(403);
    expect((await w.mgr.get(`/locations/${w.southYarra.id}/registers`)).status).toBe(403);
    expect((await w.mgr.post(`/locations/${w.southYarra.id}/registers`, { code: "SYA-1", name: "x" })).status).toBe(403);
    const audit = await w.owner.get("/audit?action=authz.denied");
    expect(audit.body.length).toBe(3);
    expect(audit.body[0].detail).toMatchObject({ permission: expect.any(String), locationId: w.southYarra.id });
    expect(audit.body[0].actorId).toBe(w.manager.id);
  });
  it("organisation-wide actions need an organisation-wide role", async () => {
    const w = await world(h);
    expect((await w.mgr.post("/locations", { code: "NEW", name: "N", type: "store", timezone: "Australia/Perth" })).status).toBe(403);
    expect((await w.mgr.get("/audit")).status).toBe(403);
    expect((await w.mgr.post("/users", { email: "x@y.test", name: "X" })).status).toBe(403);
  });
  it("the user list is limited to the caller's locations", async () => {
    const w = await world(h);
    await w.owner.post("/users", { email: "sy@kestrel.test", name: "SY Staff", assignments: [{ role: "cashier", locationId: w.southYarra.id }] });
    const names = (await w.mgr.get("/users")).body.map((u: { name: string }) => u.name).sort();
    expect(names).toEqual(["Marcus T.", "Priya N."]);
    expect((await w.owner.get("/users")).body.length).toBe(4);
  });
  it("a changed role applies on the very next request with the same token", async () => {
    const w = await world(h);
    expect((await w.mgr.get("/users")).status).toBe(200);
    expect((await w.owner.put(`/users/${w.manager.id}/assignments`, { assignments: [{ role: "cashier", locationId: w.fitzroy.id }] })).status).toBe(204);
    expect((await w.mgr.get("/users")).status).toBe(403);
    expect((await w.owner.put(`/users/${w.manager.id}/assignments`, { assignments: [] })).status).toBe(204);
    expect((await w.mgr.get(`/locations/${w.fitzroy.id}`)).status).toBe(403);
  });
  it("the last organisation-wide owner cannot be demoted or disabled", async () => {
    const w = await world(h);
    const me = (await w.owner.get("/auth/me")).body.user.id as string;
    expect((await w.owner.put(`/users/${me}/assignments`, { assignments: [] })).status).toBe(409);
    expect((await w.owner.post(`/users/${me}/disable`)).status).toBe(409);
    await w.owner.post("/users", { email: "second@kestrel.test", name: "Second", password: "second-password-123", assignments: [{ role: "owner", locationId: null }] });
    expect((await w.owner.put(`/users/${me}/assignments`, { assignments: [] })).status).toBe(204);
  });
  it("unknown roles and locations are rejected", async () => {
    const w = await world(h);
    expect((await w.owner.put(`/users/${w.cashier.id}/assignments`, { assignments: [{ role: "wizard", locationId: null }] })).body.code).toBe("unknown_role");
    expect((await w.owner.put(`/users/${w.cashier.id}/assignments`, { assignments: [{ role: "cashier", locationId: "6f0c1f1e-4b7e-4f0a-9d1e-0a0a0a0a0a0a" }] })).body.code).toBe("unknown_location");
  });
});

describe("locations, registers, devices", () => {
  it("validates time zone, uppercases codes and rejects duplicates", async () => {
    const w = await world(h);
    const bad = await w.owner.post("/locations", { code: "FRE", name: "Fremantle", type: "store", timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400); expect(bad.body.issues[0].path).toBe("timezone");
    const ok = await w.owner.post("/locations", { code: "fre", name: "Fremantle", type: "store", timezone: "Australia/Perth", dayCutoff: "03:30" });
    expect(ok.status).toBe(201); expect(ok.body).toMatchObject({ code: "FRE", dayCutoff: "03:30:00" });
    expect((await w.owner.post("/locations", { code: "FRE", name: "Dup", type: "store", timezone: "Australia/Perth" })).status).toBe(409);
    expect((await w.owner.post("/locations", { code: "TRN", name: "T", type: "transit", timezone: "Australia/Perth" })).status).toBe(400);
    expect((await w.owner.post(`/locations/${w.southYarra.id}/registers`, { code: "FIT-2", name: "dup across locations" })).status).toBe(409);
  });
  it("device keys are shown once and stored only as a hash", async () => {
    const w = await world(h);
    expect(w.device.key).toMatch(/^slk_/);
    const list = await w.owner.get(`/devices?locationId=${w.fitzroy.id}`);
    expect(JSON.stringify(list.body)).not.toContain(w.device.key);
    expect(JSON.stringify(list.body)).not.toContain("keyHash");
    const { rows } = await h.db.execute(sql`select key_hash from shelfline.device`);
    expect(String((rows[0] as { key_hash: string }).key_hash)).not.toContain(w.device.key);
  });
  it("a store manager has no device:manage by design", async () => {
    const w = await world(h);
    expect((await w.mgr.post("/devices", { kind: "pos", locationId: w.fitzroy.id, name: "x" })).status).toBe(403);
  });
  it("patching a location is audited with before and after", async () => {
    const w = await world(h);
    expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, { dayCutoff: "05:00" })).status).toBe(200);
    expect((await w.owner.patch(`/locations/${w.fitzroy.id}`, {})).status).toBe(400);
    const a = (await w.owner.get("/audit?action=location.update")).body[0];
    expect(a.before.dayCutoff).toBe("04:00:00"); expect(a.after.dayCutoff).toBe("05:00:00");
  });
});

describe("audit log", () => {
  it("is append-only at the database level", async () => {
    const w = await world(h);
    await w.owner.post("/locations", { code: "NEW", name: "New", type: "store", timezone: "Australia/Perth" });
    await expect(h.db.execute(sql`update shelfline.audit_log set action = 'tampered'`)).rejects.toThrow();
    await expect(h.db.execute(sql`delete from shelfline.audit_log`)).rejects.toThrow();
    expect((await w.owner.get("/audit?action=location.create")).body.length).toBe(3);
  });
  it("records the main actions with actor and ip, and never the PIN", async () => {
    const w = await world(h);
    const actions = (await w.owner.get("/audit?limit=200")).body.map((r: { action: string }) => r.action);
    for (const a of ["auth.login", "location.create", "user.create", "register.create", "device.create"]) expect(actions).toContain(a);
    const created = (await w.owner.get("/audit?action=user.create")).body.find((r: { subjectId: string }) => r.subjectId === w.cashier.id);
    expect(created.after).toMatchObject({ employeeCode: "117" });
    expect(JSON.stringify(created)).not.toContain("4821");
    expect(created.ip).toBeTruthy();
  });
  it("the change and its audit row commit together: a failure after the audit write rolls back both", async () => {
    const w = await world(h);
    const svc = h.app.get(AuditService);
    const real = svc.record.bind(svc);
    const spy = vi.spyOn(svc, "record").mockImplementationOnce(async (e, tx) => { await real(e, tx); throw new Error("boom after audit insert"); });
    const countAudit = () => w.owner.get("/audit?action=location.create&limit=200").then((r) => r.body.length as number);
    const before = await countAudit();
    const r = await w.owner.post("/locations", { code: "ATM", name: "Atomic", type: "store", timezone: "Australia/Perth" });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect((await w.owner.get("/locations")).body.map((l: { code: string }) => l.code)).not.toContain("ATM");
    expect(await countAudit()).toBe(before); // no orphan audit row
  });
  it("a failed create leaves no audit row", async () => {
    const w = await world(h);
    const n = () => w.owner.get("/audit?action=location.create&limit=200").then((r) => r.body.length);
    const before = await n();
    expect((await w.owner.post("/locations", { code: "FIT", name: "dup", type: "store", timezone: "Australia/Perth" })).status).toBe(409);
    expect(await n()).toBe(before);
  });
});
