import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { sql } from "drizzle-orm";
import { OWNER, reset, startApp, world, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

describe("login", () => {
  it("owner logs in; /auth/me shows organisation-wide permissions", async () => {
    const w = await world(h);
    const me = await w.owner.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(OWNER.email);
    expect(me.body.assignments[0]).toMatchObject({ role: "owner", locationId: null });
    expect(me.body.assignments[0].permissions).toContain("audit:read");
  });
  it("wrong password and unknown email give the same answer", async () => {
    await world(h);
    const a = await h.http().post("/auth/login").send({ email: OWNER.email, password: "nope-nope-nope" });
    const b = await h.http().post("/auth/login").send({ email: "ghost@kestrel.test", password: "nope-nope-nope" });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(a.body.code).toBe("invalid_credentials");
  });
  it("no token, garbage token and a POS-audience token are rejected on admin routes", async () => {
    const w = await world(h);
    expect((await h.http().get("/locations")).status).toBe(401);
    expect((await h.http().get("/locations").set("Authorization", "Bearer abc.def.ghi")).status).toBe(401);
    const pin = await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" });
    expect(pin.status).toBe(200);
    expect((await h.http().get("/locations").set("Authorization", `Bearer ${pin.body.token}`)).status).toBe(401);
  });
  it("rate limits repeated login attempts", async () => {
    await world(h);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await h.http().post("/auth/login").send({ email: "brute@kestrel.test", password: "x" })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe("sliding admin session", () => {
  it("a valid token buys a fresh one; the original sign-in time carries over; after 8 hours there is no more refreshing; a POS token cannot refresh", async () => {
    const w = await world(h);
    const r = await w.owner.post("/auth/refresh"); expect(r.status).toBe(200); expect(r.body.token).toBeTruthy(); expect(r.body.expiresInSec).toBe(900);
    const again = await h.http().post("/auth/refresh").set("Authorization", `Bearer ${r.body.token}`); expect(again.status).toBe(200);
    const { SignJWT } = await import("jose"); const key = new TextEncoder().encode("test-secret-test-secret-test-secret-123");
    const me = (await w.owner.get("/auth/me")).body.user.id;
    const old = await new SignJWT({ org: w.orgId, at: Math.floor(Date.now() / 1000) - 9 * 3600 }).setProtectedHeader({ alg: "HS256" }).setSubject(me).setAudience("admin").setIssuedAt().setExpirationTime("10m").sign(key);
    const late = await h.http().post("/auth/refresh").set("Authorization", `Bearer ${old}`); expect(late.status).toBe(401); expect(late.body.code).toBe("session_expired");
    const pin = (await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" })).body.token;
    expect((await h.http().post("/auth/refresh").set("Authorization", `Bearer ${pin}`)).status).toBe(401);
    expect((await h.http().post("/auth/refresh")).status).toBe(401);
  });
});

describe("TOTP", () => {
  it("setup, enable, then login requires a valid code", async () => {
    const w = await world(h);
    const setup = await w.owner.post("/auth/totp/setup");
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // secret is stored encrypted, never in plaintext
    const { rows } = await h.db.execute(sql`select totp_secret_enc from shelfline."user" where email = ${OWNER.email}`);
    expect(String((rows[0] as { totp_secret_enc: string }).totp_secret_enc)).not.toContain(setup.body.secret);
    expect((await w.owner.post("/auth/totp/enable", { code: "000000" })).status).toBe(401);
    expect((await w.owner.post("/auth/totp/enable", { code: await generate({ secret: setup.body.secret }) })).status).toBe(204);

    const noCode = await w.login(OWNER.email, OWNER.password);
    expect(noCode.status).toBe(401); expect(noCode.body.code).toBe("totp_required");
    const bad = await w.login(OWNER.email, OWNER.password, "123456");
    expect(bad.status).toBe(401); expect(bad.body.code).toBe("invalid_credentials");
    const good = await w.login(OWNER.email, OWNER.password, await generate({ secret: setup.body.secret }));
    expect(good.status).toBe(200);
  });
});

describe("POS PIN", () => {
  it("cashier signs in with PIN on a registered device", async () => {
    const w = await world(h);
    const r = await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ locationId: w.fitzroy.id, registerId: w.register.id });
    const me = await h.http().get("/auth/me").set("Authorization", `Bearer ${r.body.token}`);
    expect(me.body.audience).toBe("pos");
  });
  it("needs a valid device key", async () => {
    await world(h);
    expect((await h.http().post("/pos/pin").send({ employeeCode: "117", pin: "4821" })).status).toBe(401);
    expect((await h.http().post("/pos/pin").set("x-device-key", "slk_wrong").send({ employeeCode: "117", pin: "4821" })).status).toBe(401);
  });
  it("locks after 5 wrong PINs, even for the right PIN, until a manager resets it", async () => {
    const w = await world(h);
    const go = (pin: string) => h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin });
    for (let i = 0; i < 5; i++) expect((await go("0000")).status).toBe(401);
    const locked = await go("4821");
    expect(locked.status).toBe(423); expect(locked.body.code).toBe("pin_locked");
    expect((await w.owner.post(`/users/${w.cashier.id}/pin`, { pin: "9911" })).status).toBe(204);
    expect((await go("9911")).status).toBe(200);
    const audit = await w.owner.get("/audit?action=auth.pin_locked");
    expect(audit.body.length).toBe(1);
  });
  it("a cashier not assigned to the device's location is refused", async () => {
    const w = await world(h);
    await w.owner.put(`/users/${w.cashier.id}/assignments`, { assignments: [{ role: "cashier", locationId: w.southYarra.id }] });
    const r = await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" });
    expect(r.status).toBe(403); expect(r.body.code).toBe("not_assigned_to_location");
  });
  it("revoking the device invalidates tokens it already issued", async () => {
    const w = await world(h);
    const t = (await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" })).body.token;
    expect((await h.http().get("/auth/me").set("Authorization", `Bearer ${t}`)).status).toBe(200);
    expect((await w.owner.post(`/devices/${w.device.id}/revoke`)).status).toBe(204);
    expect((await h.http().get("/auth/me").set("Authorization", `Bearer ${t}`)).status).toBe(401);
    expect((await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" })).status).toBe(401);
  });
  it("disabling a user cuts their live token and clears the PIN", async () => {
    const w = await world(h);
    const t = (await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" })).body.token;
    expect((await w.owner.post(`/users/${w.cashier.id}/disable`)).status).toBe(204);
    expect((await h.http().get("/auth/me").set("Authorization", `Bearer ${t}`)).status).toBe(401);
    expect((await h.http().post("/pos/pin").set("x-device-key", w.device.key).send({ employeeCode: "117", pin: "4821" })).status).toBe(401);
  });
});
