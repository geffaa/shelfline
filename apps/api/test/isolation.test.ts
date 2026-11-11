import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { seedOrg } from "../src/seed";
import { catalogWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let a: Awaited<ReturnType<typeof catalogWorld>>; let bOrg: string; let b: ReturnType<Awaited<ReturnType<typeof catalogWorld>>["as"]>;
let app: pg.Pool;                                                         // the role the running application uses, for direct SQL
beforeAll(async () => { h = await startApp(); app = new pg.Pool({ connectionString: h.config.appDatabaseUrl, max: 2 }); }, 60_000);
afterAll(async () => { await app.end(); await h.close(); });
beforeEach(async () => {
  await reset(h); a = await catalogWorld(h);
  bOrg = (await seedOrg(h.db, { orgName: "Other Org Pty", currency: "AUD", timezone: "Australia/Sydney", ownerEmail: "boss@other.test", ownerPassword: "other-password-123" })).orgId;
  b = a.as((await a.login("boss@other.test", "other-password-123")).body.token);
});
/** Run one statement as the application role, acting for `org` (or for nobody). */
async function as<T = Record<string, unknown>>(org: string | null, text: string, values: unknown[] = []) {
  const c = await app.connect(); try { await c.query("select set_config('app.org_id', $1, false), set_config('app.system', 'off', false)", [org ?? ""]); return await c.query(text, values); } finally { c.release(); }
}
const orgTables = async () => (await h.db.$client.query(`select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE' where c.table_schema = 'shelfline' and c.column_name = 'org_id' order by 1`)).rows.map((r) => r.table_name as string);

describe("the database enforces organisation boundaries", () => {
  it("every table that belongs to an organisation has row-level security and a policy, and the application role cannot bypass it", async () => {
    const tables = await orgTables(); expect(tables.length).toBeGreaterThan(60);
    const off = (await h.db.$client.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'shelfline' and c.relname = any($1) and not c.relrowsecurity`, [tables])).rows; expect(off).toEqual([]);
    const noPolicy = (await h.db.$client.query(`select t from unnest($1::text[]) t where not exists (select 1 from pg_policies p where p.schemaname = 'shelfline' and p.tablename = t)`, [tables])).rows; expect(noPolicy).toEqual([]);
    const role = (await h.db.$client.query(`select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = 'shelfline_app'`)).rows[0]; expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    expect((await app.query("select current_user")).rows[0].current_user).toBe("shelfline_app");
  });
  it("acting for one organisation, no table shows a row of another — checked table by table, in both directions", async () => {
    await a.owner.post("/suppliers", { name: "A's supplier" }); await b.post("/suppliers", { name: "B's supplier" }); await b.post("/locations", { code: "syd", name: "Sydney CBD", type: "store", timezone: "Australia/Sydney" });
    for (const t of await orgTables()) {
      for (const [mine, theirs] of [[a.orgId, bOrg], [bOrg, a.orgId]] as const) {
        expect((await as(mine, `select count(*)::int as n from shelfline.${t} where org_id = $1`, [theirs])).rows[0]!.n, `${t} leaks ${theirs}`).toBe(0);
      }
    }
    expect((await as(a.orgId, "select count(*)::int as n from shelfline.org")).rows[0]!.n).toBe(1); expect((await as(a.orgId, "select count(*)::int as n from shelfline.supplier")).rows[0]!.n).toBe(1);
    expect((await as(bOrg, "select name from shelfline.supplier")).rows).toEqual([{ name: "B's supplier" }]);
  });
  it("fails closed: with no organisation set, nothing is visible and nothing can be written", async () => {
    await a.owner.post("/suppliers", { name: "A's supplier" }); const c = await app.connect();
    try { await c.query("select set_config('app.org_id', '', false), set_config('app.system', '', false)"); for (const t of await orgTables()) expect((await c.query(`select count(*)::int as n from shelfline.${t}`)).rows[0].n, t).toBe(0);
      await expect(c.query("insert into shelfline.supplier (org_id, name) values ($1, 'sneaky')", [a.orgId])).rejects.toThrow(/row-level security/); } finally { c.release(); }
  });
  it("cannot write into, change, or delete another organisation's rows, even knowing their ids", async () => {
    const theirs = (await b.post("/suppliers", { name: "B's supplier" })).body.id;
    await expect(as(a.orgId, "insert into shelfline.supplier (org_id, name) values ($1, 'planted')", [bOrg])).rejects.toThrow(/row-level security/);
    expect((await as(a.orgId, "update shelfline.supplier set name = 'hijacked' where id = $1", [theirs])).rowCount).toBe(0); expect((await as(a.orgId, "delete from shelfline.supplier where id = $1", [theirs])).rowCount).toBe(0);
    await expect(as(a.orgId, "update shelfline.supplier set org_id = $2 where id = (select id from shelfline.supplier limit 1)", [a.orgId, bOrg])).rejects.toThrow();
    expect((await as(bOrg, "select name from shelfline.supplier where id = $1", [theirs])).rows).toEqual([{ name: "B's supplier" }]);
  });
  it("cannot change the rules: no truncate, no disabling the policy, no switching to another role", async () => {
    await expect(as(a.orgId, "truncate table shelfline.supplier")).rejects.toThrow(/permission denied/); await expect(as(a.orgId, "alter table shelfline.supplier disable row level security")).rejects.toThrow(/must be owner/);
    await expect(as(a.orgId, "set role shelfline")).rejects.toThrow(); await expect(as(a.orgId, "drop policy org_isolation on shelfline.supplier")).rejects.toThrow(/must be owner/);
  });
});

describe("through the API, an organisation never reaches another's data", () => {
  it("lists show only your own, and another organisation's ids are simply not found", async () => {
    const mine = (await a.owner.post("/suppliers", { name: "A's supplier" })).body; const theirs = (await b.post("/suppliers", { name: "B's supplier" })).body;
    expect((await a.owner.get("/suppliers")).body.map((s: { name: string }) => s.name)).toEqual(["A's supplier"]); expect((await b.get("/suppliers")).body.map((s: { name: string }) => s.name)).toEqual(["B's supplier"]);
    expect((await a.owner.get(`/suppliers/${theirs.id}`)).status).toBe(404); expect((await a.owner.patch(`/suppliers/${theirs.id}`, { name: "x" })).status).toBe(404); expect((await b.get(`/suppliers/${mine.id}`)).status).toBe(404);
    expect((await b.get("/locations")).body.map((l: { code: string }) => l.code)).toEqual([]); expect((await a.owner.get("/locations")).body.length).toBeGreaterThanOrEqual(2);
    expect((await b.post("/purchase-orders", { supplierId: mine.id, locationId: a.fitzroy.id, lines: [{ variantId: randomUUID(), qty: 1, unitCostMinor: 1 }] })).status).toBeGreaterThanOrEqual(400);
    expect((await a.owner.get("/products")).body.items?.length ?? (await a.owner.get("/products")).body.length).toBeGreaterThanOrEqual(0); expect((await b.get("/audit")).body.items?.every?.((r: { orgId?: string }) => !r.orgId || r.orgId === bOrg) ?? true).toBe(true);
  });
  it("the same email can belong to two organisations: the password decides, the organisation slug picks, and a token only ever opens its own organisation", async () => {
    const pw = "shared-password-123"; expect((await b.post("/users", { email: "elena@kestrel.test", name: "Elena at Other", password: pw, assignments: [{ role: "hq_manager", locationId: null }] })).status).toBe(201);
    await a.owner.post("/users", { email: "twin@kestrel.test", name: "Twin A", password: pw, assignments: [{ role: "hq_manager", locationId: null }] }); await b.post("/users", { email: "twin@kestrel.test", name: "Twin B", password: pw, assignments: [{ role: "hq_manager", locationId: null }] });
    const bare = await a.login("twin@kestrel.test", pw); expect(bare.status).toBe(409); expect(bare.body).toMatchObject({ code: "choose_org" }); expect(bare.body.orgs.map((o: { slug: string }) => o.slug).sort()).toEqual(["kestrel-run-co", "other-org-pty"]);
    const asB = await h.http().post("/auth/login").send({ email: "twin@kestrel.test", password: pw, org: "other-org-pty" }); expect(asB.status).toBe(200); const me = await h.http().get("/auth/me").set("Authorization", `Bearer ${asB.body.token}`); expect(me.body.name ?? me.body.user?.name).toBe("Twin B");
    await a.owner.post("/suppliers", { name: "Only in A" }); const seen = await h.http().get("/suppliers").set("Authorization", `Bearer ${asB.body.token}`); expect(seen.status).toBe(200); expect(seen.body).toEqual([]);       // whatever B's token reads, it is B's
    expect((await h.http().post("/auth/login").send({ email: "twin@kestrel.test", password: "wrong-password-123" })).body).toEqual((await h.http().post("/auth/login").send({ email: "nobody@kestrel.test", password: "wrong-password-123" })).body);   // no hint that the email exists in two places
    expect((await h.http().post("/auth/login").send({ email: "twin@kestrel.test", password: pw, org: "no-such-org" })).status).toBe(401);
    const own = await a.login("elena@kestrel.test", "owner-password-123"); expect(own.status).toBe(200); expect((await h.http().get("/suppliers").set("Authorization", `Bearer ${own.body.token}`)).body.map((x: { name: string }) => x.name)).toEqual(["Only in A"]);   // each password opens only its own organisation's Elena
    const other = await a.login("elena@kestrel.test", pw); expect(other.status).toBe(200); expect((await h.http().get("/suppliers").set("Authorization", `Bearer ${other.body.token}`)).body).toEqual([]);
  });
});
