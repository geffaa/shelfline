import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { FakeIdp } from "../test-support/fake-idp";
import { forgetProviders } from "../src/sso/oidc";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

const idp = new FakeIdp(); const ISSUER = idp.issuer; const CLIENT = idp.clientId; const SECRET = idp.clientSecret;
let h: Harness; let w: Awaited<ReturnType<typeof catalogWorld>>;
beforeAll(async () => { await idp.start(); h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); idp.stop(); });
beforeEach(async () => { await reset(h); await h.db.execute(sql`truncate table shelfline.sso_ticket, shelfline.sso_connection cascade`); forgetProviders(); idp.tamper = {}; idp.down = false; idp.tokenCalls = 0; w = await catalogWorld(h); });
const configure = (o: object = {}) => w.owner.put("/sso", { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, emailDomains: ["kestrel.test"], enabled: true, ...o });
const start = async () => (await h.http().get("/auth/sso/start?org=kestrel-run-co")).body.url as string;
const back = async (code: string, state: string) => { const r = await h.http().get(`/auth/sso/callback?${new URLSearchParams({ code, state })}`); expect(r.status).toBe(302); const u = new URL(r.headers.location!.replace("/#/", "/")); return { loc: r.headers.location!, ticket: u.searchParams.get("ticket"), error: u.searchParams.get("error") }; };
const exchange = (ticket: string) => h.http().post("/auth/sso/exchange").send({ ticket });
/** The whole dance for one person; returns what the callback sent the browser to. */
const signIn = async (email: string) => { const url = await start(); const { code, state } = idp.approve(url, email); return back(code, state); };

describe("setting it up", () => {
  it("is for owners; the secret is stored encrypted and never shown; the provider is checked before it is saved", async () => {
    expect((await w.hqApi.put("/sso", { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET })).status).toBe(403); expect((await w.hqApi.get("/sso")).status).toBe(403); expect((await w.owner.get("/sso")).body).toMatchObject({ configured: false, redirectUri: expect.stringContaining("/auth/sso/callback") });
    const ok = await configure(); expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ configured: true, issuer: ISSUER, clientId: CLIENT, emailDomains: ["kestrel.test"], enabled: true }); expect(JSON.stringify(ok.body)).not.toContain(SECRET);
    expect((await h.db.execute(sql`select client_secret_enc from shelfline.sso_connection`)).rows[0]!.client_secret_enc).not.toContain(SECRET);
    expect((await configure({ clientSecret: undefined, enabled: false })).body).toMatchObject({ enabled: false });                  // keeping the stored secret when none is sent
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.audit_log where action = 'sso.configure'`)).rows[0]!.n).toBe(2);
    expect((await configure({ issuer: "http://example.com" })).body).toMatchObject({ code: "sso_insecure_url" }); idp.tamper = { discoveryIssuer: "https://someone-else.test" }; forgetProviders(); expect((await configure()).body).toMatchObject({ code: "sso_issuer_mismatch" });
    idp.tamper = {}; forgetProviders(); idp.down = true; expect((await configure({ issuer: ISSUER + "/" })).status).toBe(400); idp.down = false;
    expect((await w.owner.delete("/sso")).status).toBe(204); expect((await w.owner.get("/sso")).body.configured).toBe(false);
  });
});

describe("signing in through the provider", () => {
  it("a person the organisation already has signs in with one trip to the provider, and the ticket works once", async () => {
    await configure(); const r = await signIn("dana@kestrel.test"); expect(r.error).toBeNull(); expect(r.loc.startsWith("http://localhost:8220/#/sso?ticket=")).toBe(true);
    const t = await exchange(r.ticket!); expect(t.status).toBe(200); const me = await h.http().get("/auth/me").set("Authorization", `Bearer ${t.body.token}`); expect(me.body.email ?? me.body.user?.email).toBe("dana@kestrel.test");
    expect((await h.http().get("/suppliers").set("Authorization", `Bearer ${t.body.token}`)).status).toBe(200);
    expect((await exchange(r.ticket!)).status).toBe(401);                                                                           // a ticket is used once
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.audit_log where action = 'auth.login' and after->>'method' = 'sso'`)).rows[0]!.n).toBe(1);
  });
  it("the email may differ in case, and the organisation is the one named, not the one the email is in elsewhere", async () => {
    await configure(); expect((await signIn("DANA@Kestrel.Test")).ticket).toBeTruthy();
  });
  it("refuses a code that was already used and a made-up ticket", async () => {
    await configure(); const url = await start(); const { code, state } = idp.approve(url, "dana@kestrel.test"); expect((await back(code, state)).ticket).toBeTruthy(); expect((await back(code, state)).error).toBe("sign_in_failed");
    expect((await exchange(randomUUID())).body).toMatchObject({ code: "invalid_ticket" });
  });
  it("an expired ticket is refused", async () => {
    await configure(); const r = await signIn("dana@kestrel.test"); await h.db.execute(sql`update shelfline.sso_ticket set expires_at = now() - interval '1 second'`); expect((await exchange(r.ticket!)).status).toBe(401);
  });
  it("only people who already exist, are active, and have an allowed email domain; nobody is created by signing in", async () => {
    await configure(); const before = (await h.db.execute(sql`select count(*)::int as n from shelfline.user`)).rows[0]!.n;
    expect((await signIn("stranger@kestrel.test")).error).toBe("not_allowed"); expect((await signIn("dana@elsewhere.test")).error).toBe("not_allowed");
    await h.db.execute(sql`update shelfline.user set status = 'disabled' where email = 'dana@kestrel.test'`); expect((await signIn("dana@kestrel.test")).error).toBe("not_allowed");
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.user`)).rows[0]!.n).toBe(before); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sso_ticket`)).rows[0]!.n).toBe(0);
    const why = (await h.db.execute(sql`select after->>'reason' as r from shelfline.audit_log where action = 'sso.login_failed' order by at`)).rows.map((x) => x.r); expect(why).toEqual(["no_such_user", "domain_not_allowed", "no_such_user"]);
  });
  it("does not trust an email the provider has not verified", async () => {
    await configure(); idp.tamper = { emailVerified: false }; expect((await signIn("dana@kestrel.test")).error).toBe("not_allowed"); idp.tamper = { noEmail: true }; expect((await signIn("dana@kestrel.test")).error).toBe("sign_in_failed");
  });
  it("rejects an ID token that is for another app, from another issuer, expired, replayed with another nonce, or signed by a key the provider never published", async () => {
    await configure();
    for (const t of [{ aud: "someone-elses-client" }, { iss: "https://evil.test" }, { expired: true }, { nonce: "not-ours" }, { wrongKey: true }]) { idp.tamper = t; const r = await signIn("dana@kestrel.test"); expect(r.error, JSON.stringify(t)).toBe("sign_in_failed"); expect(r.ticket).toBeNull(); }
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sso_ticket`)).rows[0]!.n).toBe(0);
  });
  it("rejects a tampered, foreign or expired state, and a callback that the provider refused", async () => {
    await configure(); const url = await start(); const { code, state } = idp.approve(url, "dana@kestrel.test");
    expect((await back(code, state.slice(0, -3) + "abc")).error).toBe("state_invalid"); expect((await back(code, "garbage")).error).toBe("state_invalid");
    const foreign = await new SignJWT({ org: w.orgId, nonce: "n", verifier: "v" }).setProtectedHeader({ alg: "HS256" }).setAudience("sso-state").setExpirationTime("10m").sign(new TextEncoder().encode("another-secret-another-secret-12345678")); expect((await back(code, foreign)).error).toBe("state_invalid");
    const wrongAud = await new SignJWT({ org: w.orgId }).setProtectedHeader({ alg: "HS256" }).setAudience("admin").setExpirationTime("10m").sign(new TextEncoder().encode(h.config.jwtSecret)); expect((await back(code, wrongAud)).error).toBe("state_invalid");
    const r = await h.http().get("/auth/sso/callback?error=access_denied"); expect(r.headers.location).toContain("error=provider_refused"); expect(idp.tokenCalls).toBe(0);
  });
  it("a state for one organisation cannot sign someone into another", async () => {
    await configure(); const { seedOrg } = await import("../src/seed"); const other = (await seedOrg(h.db, { orgName: "Other Org Pty", currency: "AUD", timezone: "Australia/Sydney", ownerEmail: "boss@other.test", ownerPassword: "other-password-123" })).orgId;
    const url = await start(); const { code, state } = idp.approve(url, "boss@other.test"); expect((await back(code, state)).error).toBe("not_allowed");     // boss@other.test is not a user of the organisation the state names
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sso_ticket where org_id = ${other}`)).rows[0]!.n).toBe(0);
  });
  it("says it is not available for an organisation without SSO, with it switched off, or that does not exist; and survives the provider being down", async () => {
    expect((await h.http().get("/auth/sso/start?org=kestrel-run-co")).status).toBe(404); await configure({ enabled: false }); expect((await h.http().get("/auth/sso/start?org=kestrel-run-co")).status).toBe(404); expect((await h.http().get("/auth/sso/start?org=nope-nope")).status).toBe(404);
    await configure(); forgetProviders(); idp.down = true; expect((await h.http().get("/auth/sso/start?org=kestrel-run-co")).status).toBe(400); idp.down = false;
  });
  it("sign-in with a password keeps working next to it", async () => {
    await configure(); expect((await w.login("elena@kestrel.test", "owner-password-123")).status).toBe(200);
  });
});
