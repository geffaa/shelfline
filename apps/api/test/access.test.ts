import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { zonedInstant } from "../src/common/business-day";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); w = await posWorld(h, { stock: 100 });
  await h.db.execute(sql`truncate table shelfline.email_outbox, shelfline.report_view_log, shelfline.portal_login_code restart identity cascade`);
  session = randomUUID(); expect((await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 30000 })])).body.results[0].status).toBe("accepted");
});
const TZ = "Australia/Melbourne"; const at = (date: string, hm = "12:00") => new Date(zonedInstant(date, hm, TZ)).toISOString();

async function sell(variant: number, qty: number, date: string, o: { location?: string } = {}) {
  const lines = [{ variantId: w.v[variant]!.id, qty, unitPriceMinor: [21995, 8900, 3400][variant]!, discountMinor: 0 }];
  const priced = priceCart(lines.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const sale = { saleId, sessionId: session, receiptNo: `R-${saleId.slice(0, 6)}`, customerId: null, lines, payments: [{ tender: "card", amountMinor: priced.payableMinor }],
    totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null };
  expect((await w.push([w.cmd("sale.create", sale)])).body.results[0].status).toBe("accepted");
  await h.db.execute(sql`update shelfline.sale set local_date = ${date}::date, effective_at = ${at(date)}::timestamptz, client_ts = ${at(date)}::timestamptz ${o.location ? sql`, location_id = ${o.location}::uuid` : sql``} where id = ${saleId}`);
  return { saleId, net: priced.totalMinor };
}
/** Sales that tell places and days apart by their amount. */
async function seed() {
  return {
    inOct1: await sell(0, 1, "2026-10-10"),                       // Fitzroy, inside
    inOct2: await sell(1, 2, "2026-10-20"),                       // Fitzroy, inside
    before: await sell(2, 1, "2026-09-30"),                       // Fitzroy, day before the window
    after: await sell(0, 2, "2026-11-01"),                        // Fitzroy, day after
    other: await sell(1, 3, "2026-10-12", { location: w.southYarra.id }),   // South Yarra, inside the dates
  };
}
const grantBody = (o: object = {}) => ({ email: "ines@accounts.test", name: "Ines Walker", reportKeys: ["sales"], locationIds: [w.fitzroy.id], rangeKind: "fixed", rangeFrom: "2026-10-01", rangeTo: "2026-10-31", hiddenColumns: ["costMinor"], ...o });
const grant = async (o: object = {}) => { const r = await w.owner.post("/report-grants", grantBody(o)); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; };
const mailbox = async (to: string) => (await h.http().get(`/dev/mailbox?to=${encodeURIComponent(to)}`)).body as { subject: string; body: string; kind: string }[];
/** Signs in the way a person does: ask for a code, read it from the mail, give it back. */
async function signIn(email = "ines@accounts.test") {
  expect((await h.http().post("/portal/auth/request-code").send({ email })).status).toBe(204);
  const code = /(\d{6})/.exec((await mailbox(email)).find((m) => m.kind === "portal_code")!.subject)![1]!;
  const r = await h.http().post("/portal/auth/verify").send({ email, code }); expect(r.status, JSON.stringify(r.body)).toBe(200);
  const tok = r.body.token as string; return { tok, code, get: (u: string) => h.http().get(u).set("Authorization", `Bearer ${tok}`), post: (u: string, b?: object) => h.http().post(u).set("Authorization", `Bearer ${tok}`).send(b ?? {}) };
}
/** What a reader could read out of a response: the columns, the rows and the totals. (The scope block names what is hidden so the screen can say so; it carries no values.) */
const data = (b: { columns: unknown; rows: unknown; totals: unknown }) => JSON.stringify({ columns: b.columns, rows: b.rows, totals: b.totals });
const q = (o: Record<string, string | undefined>) => "?" + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();
const expectedNet = async (from: string, to: string, loc: string) => Number((await h.db.execute(sql`select coalesce(sum(sl.total_minor - sl.refunded_minor), 0) as n from shelfline.sale s join shelfline.sale_line sl on sl.sale_id = s.id where s.location_id = ${loc}::uuid and s.local_date between ${from}::date and ${to}::date`)).rows[0]!.n);

describe("signing in to the portal", () => {
  it("a person with a grant gets a one-time code by mail and can use it once; the code is stored only as a hash", async () => {
    await grant(); expect((await mailbox("ines@accounts.test")).map((m) => m.kind)).toEqual(["portal_invite"]);
    const s = await signIn(); expect((await s.get("/portal/me")).body).toMatchObject({ name: "Ines Walker", email: "ines@accounts.test" });
    expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code: s.code })).status).toBe(401);          // used
    const [row] = (await h.db.execute(sql`select code_hash from shelfline.portal_login_code`)).rows; expect(row!.code_hash).not.toContain(s.code); expect(String(row!.code_hash)).toHaveLength(64);
    expect((await w.owner.get("/audit?action=portal.sign_in")).body.length).toBe(1);
  });
  it("wrong codes are counted and the fifth locks that code, even for the right digits; an older code stops working when a new one is asked for", async () => {
    await grant(); await h.http().post("/portal/auth/request-code").send({ email: "ines@accounts.test" });
    const code = /(\d{6})/.exec((await mailbox("ines@accounts.test")).find((m) => m.kind === "portal_code")!.subject)![1]!; const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code: wrong })).status).toBe(401);
    expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code })).status).toBe(429);
    await h.http().post("/portal/auth/request-code").send({ email: "ines@accounts.test" }); const codes = (await mailbox("ines@accounts.test")).filter((m) => m.kind === "portal_code").map((m) => /(\d{6})/.exec(m.subject)![1]!);
    expect(codes).toHaveLength(2); const [newer, older] = codes as [string, string];
    if (older !== newer) expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code: older })).status).toBe(401);
    expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code: newer })).status).toBe(200);
  });
  it("answers the same for strangers and for people with no grant, and sends them nothing; asking over and over is capped", async () => {
    await grant();
    expect((await h.http().post("/portal/auth/request-code").send({ email: "nobody@nowhere.test" })).status).toBe(204); expect(await mailbox("nobody@nowhere.test")).toEqual([]);
    expect((await h.http().post("/portal/auth/request-code").send({ email: "priya@kestrel.test" })).status).toBe(204); expect(await mailbox("priya@kestrel.test")).toEqual([]);      // staff with no grant
    for (let i = 0; i < 8; i++) await h.http().post("/portal/auth/request-code").send({ email: "ines@accounts.test" });
    expect((await mailbox("ines@accounts.test")).filter((m) => m.kind === "portal_code")).toHaveLength(5);
    expect((await h.http().post("/portal/auth/verify").send({ email: "ines@accounts.test", code: "12345" })).status).toBe(400);
  });
  it("a report reader cannot sign in to the back office and is not listed as staff", async () => {
    await grant(); expect((await w.login("ines@accounts.test", "anything-at-all-123")).status).toBe(401);
    expect((await w.owner.get("/users")).body.some((u: { email: string }) => u.email === "ines@accounts.test")).toBe(false);
  });
});

describe("what a grant lets through, by every route", () => {
  it("Fitzroy, 1-31 October, no cost: nothing else gets out by place, date, column, group, preview or CSV", async () => {
    const s = await seed(); const id = await grant(); const reader = await signIn(); const URL = (key = "sales") => `/portal/grants/${id}/reports/${key}`;
    const inside = s.inOct1.net + s.inOct2.net;
    expect(await expectedNet("2026-10-01", "2026-10-31", w.fitzroy.id)).toBe(inside);
    const day = (await reader.get(URL() + q({ groupBy: "day" }))).body;
    expect(day.rows.map((r: { label: string }) => r.label)).toEqual(["2026-10-10", "2026-10-20"]); expect(day.totals.netMinor).toBe(inside);
    expect(day.scope).toMatchObject({ from: "2026-10-01", to: "2026-10-31", locations: ["Fitzroy"], clamped: false });
    const loc = (await reader.get(URL() + q({ groupBy: "location" }))).body; expect(loc.rows.map((r: { label: string }) => r.label)).toEqual(["Fitzroy"]);
    // the columns: cost and margin do not exist in the answer
    for (const body of [day, loc]) { expect(body.columns.map((c: { key: string }) => c.key)).not.toContain("costMinor"); expect(body.columns.map((c: { key: string }) => c.key)).not.toContain("marginMinor"); expect(data(body)).not.toMatch(/costMinor|marginMinor/); }
    // asking for more is cut to the window, never refused with a leak and never widened
    const wide = (await reader.get(URL() + q({ from: "2020-01-01", to: "2030-12-31" }))).body; expect(wide.totals.netMinor).toBe(inside); expect(wide.scope).toMatchObject({ from: "2026-10-01", to: "2026-10-31", clamped: true });
    expect((await reader.get(URL() + q({ from: "2026-11-01", to: "2026-11-30" }))).body).toMatchObject({ rows: [], scope: { empty: true } });
    expect((await reader.get(URL() + q({ locationId: w.southYarra.id }))).status).toBe(403); expect((await reader.get(URL() + q({ locationId: randomUUID() }))).status).toBe(403);
    expect((await reader.get(URL() + q({ locationId: w.fitzroy.id, from: "2026-10-15" }))).body.totals.netMinor).toBe(s.inOct2.net);
    // the file download goes through the same scope
    const csv = await reader.get(URL() + q({ groupBy: "day", from: "2026-01-01", to: "2026-12-31", format: "csv" })); expect(csv.status).toBe(200);
    expect(csv.text.split("\n")[0]).toBe("Day,Orders,Items,Gross,Discounts,Refunds,Net,GST included"); expect(csv.text).not.toMatch(/2026-09|2026-11|Cost|Margin|South Yarra/); expect(csv.text).toContain("2026-10-10");
    expect((await reader.get(URL() + q({ locationId: w.southYarra.id, format: "csv" }))).status).toBe(403);
    // another report that was not granted
    expect((await reader.get(URL("cash_variance"))).status).toBe(403); expect((await reader.get(URL("nope"))).status).toBe(403);
    // preview shows the administrator exactly what the reader gets
    const prev = (await w.owner.get(`/report-grants/${id}/preview/sales` + q({ groupBy: "day" }))).body; expect(prev.rows).toEqual(day.rows); expect(prev.columns).toEqual(day.columns);
  });
  it("a matrix of places, dates, groupings and formats never returns a row outside the grant", async () => {
    const s = await seed(); const id = await grant({ locationIds: [w.fitzroy.id] }); const reader = await signIn(); void s;
    const bad = ["2026-09-30", "2026-11-01"]; let served = 0;
    for (const loc of [undefined, w.fitzroy.id, w.southYarra.id, randomUUID()]) for (const from of [undefined, "2026-09-01", "2026-10-15", "2026-11-01"]) for (const to of [undefined, "2026-10-12", "2026-12-31"]) for (const groupBy of ["day", "location", "product"]) for (const format of ["json", "csv"]) {
      const r = await reader.get(`/portal/grants/${id}/reports/sales` + q({ locationId: loc, from, to, groupBy, format }));
      if (loc && loc !== w.fitzroy.id) { expect(r.status).toBe(403); continue; }
      expect(r.status).toBe(200); served++;
      const text = format === "csv" ? r.text : data(r.body);
      expect(text).not.toMatch(/South Yarra|costMinor|marginMinor|Cost of goods|Margin/); for (const d of bad) expect(text).not.toContain(d);
      if (format === "json") { const lo = from && from > "2026-10-01" ? from : "2026-10-01", hi = to && to < "2026-10-31" ? to : "2026-10-31"; expect(r.body.totals?.netMinor ?? 0).toBe(lo > hi ? 0 : await expectedNet(lo, hi, w.fitzroy.id)); }
    }
    expect(served).toBe(2 * 4 * 3 * 3 * 2);
  });
  it("hiding net hides the order it would give away; two places granted are both visible and nothing else", async () => {
    await seed(); const id = await grant({ locationIds: [w.fitzroy.id, w.southYarra.id], hiddenColumns: ["netMinor", "costMinor"] }); const reader = await signIn();
    const loc = (await reader.get(`/portal/grants/${id}/reports/sales` + q({ groupBy: "location" }))).body;
    expect(loc.rows.map((r: { label: string }) => r.label)).toEqual(["Fitzroy", "South Yarra"]); expect(loc.columns.map((c: { key: string }) => c.key)).not.toContain("netMinor"); expect(data(loc)).not.toMatch(/netMinor/); expect(loc.totals.grossMinor).toBeGreaterThan(0);
  });
  it("cost and margin reach a reader only when the grant leaves them in, and margin goes whenever cost does", async () => {
    await seed(); const open = await grant({ email: "open@accounts.test", hiddenColumns: [] }); const marginOnly = await grant({ email: "m@accounts.test", hiddenColumns: ["marginMinor"] }); const costHidden = await grant({ email: "c@accounts.test", hiddenColumns: ["costMinor"] });
    const a = await signIn("open@accounts.test"), b = await signIn("m@accounts.test"), c = await signIn("c@accounts.test");
    const full = (await a.get(`/portal/grants/${open}/reports/sales` + q({ groupBy: "day" }))).body; expect(full.columns.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(["costMinor", "marginMinor"])); expect(full.totals.costMinor).toBeGreaterThan(0);
    expect(full.totals.marginMinor).toBe(full.totals.netMinor - full.totals.taxMinor - full.totals.costMinor);
    const nm = (await b.get(`/portal/grants/${marginOnly}/reports/sales`)).body; expect(nm.columns.map((x: { key: string }) => x.key)).toContain("costMinor"); expect(nm.columns.map((x: { key: string }) => x.key)).not.toContain("marginMinor");
    const nc = (await c.get(`/portal/grants/${costHidden}/reports/sales`)).body; expect(data(nc)).not.toMatch(/costMinor|marginMinor/);
  });
  it("a rolling window is worked out when the report is asked for", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); const ago = (n: number) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);
    const near = await sell(0, 1, ago(3)); await sell(1, 1, ago(20));
    const id = await grant({ rangeKind: "rolling", rangeFrom: null, rangeTo: null, rollingDays: 7 }); const reader = await signIn();
    const r = (await reader.get(`/portal/grants/${id}/reports/sales` + q({ from: ago(60) }))).body; expect(r.scope).toMatchObject({ from: ago(6), to: today, clamped: true }); expect(r.totals.netMinor).toBe(near.net);
    await h.db.execute(sql`alter table shelfline.report_grant disable trigger report_grant_guard`); await h.db.execute(sql`update shelfline.report_grant set rolling_days = 30 where id = ${id}`); await h.db.execute(sql`alter table shelfline.report_grant enable trigger report_grant_guard`);
    expect((await reader.get(`/portal/grants/${id}/reports/sales`)).body.totals.netMinor).toBe(near.net + 8900 * 1 /* the 20 day old sale, now inside */);
  });
  it("the cash variance report lists closed sessions of the granted places only", async () => {
    await w.push([w.cmd("session.close", { sessionId: session, countedMinor: 29000 })]);
    const id = await grant({ reportKeys: ["sales", "cash_variance"], rangeFrom: "2020-01-01", rangeTo: "2030-12-31", hiddenColumns: [] }); const reader = await signIn();
    const r = (await reader.get(`/portal/grants/${id}/reports/cash_variance`)).body; expect(r.rows).toHaveLength(1); expect(r.rows[0]).toMatchObject({ location: "Fitzroy", countedMinor: 29000 }); expect(r.rows[0].varianceMinor).toBe(29000 - r.rows[0].expectedMinor);
    const other = await grant({ email: "sy@accounts.test", reportKeys: ["cash_variance"], locationIds: [w.southYarra.id], rangeFrom: "2020-01-01", rangeTo: "2030-12-31", hiddenColumns: [] }); const sy = await signIn("sy@accounts.test");
    expect((await sy.get(`/portal/grants/${other}/reports/cash_variance`)).body.rows).toEqual([]);
    expect((await sy.get(`/portal/grants/${id}/reports/cash_variance`)).status).toBe(404);                  // someone else's grant is not even visible
  });
});

describe("the portal and the back office are separate", () => {
  it("a portal token is refused by every back-office route, and a back-office token by the portal", async () => {
    await seed(); const id = await grant(); const reader = await signIn();
    for (const u of ["/report-grants", "/report-catalog", "/users", "/reports/sales?from=2026-10-01&to=2026-10-31", "/commission/rules", "/orders", "/locations", "/audit", "/purchase-orders", "/timesheets", "/auth/me"]) expect([u, (await reader.get(u)).status]).toEqual([u, 401]);
    expect((await reader.post("/report-grants", grantBody())).status).toBe(401); expect((await reader.post(`/report-grants/${id}/revoke`)).status).toBe(401); expect((await reader.post("/commission/recalculate")).status).toBe(401);
    for (const u of ["/portal/me", "/portal/grants", `/portal/grants/${id}/reports/sales`]) expect([u, (await w.owner.get(u)).status]).toEqual([u, 401]);
    expect((await h.http().get("/portal/grants")).status).toBe(401);
  });
  it("only owners can give access; a manager and a finance user cannot", async () => {
    expect((await w.mgr.post("/report-grants", grantBody())).status).toBe(403); expect((await w.mgr.get("/report-grants")).status).toBe(403);
    await w.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-12", assignments: [{ role: "finance", locationId: null }] });
    const fin = w.as((await w.login("fin@kestrel.test", "finance-password-12")).body.token); expect((await fin.post("/report-grants", grantBody())).status).toBe(403);
  });
});

describe("granting, ending and watching", () => {
  it("validates what it is given", async () => {
    for (const bad of [{ reportKeys: [] }, { reportKeys: ["nope"] }, { hiddenColumns: ["label"] }, { hiddenColumns: ["bogus"] }, { locationIds: [] }, { rangeFrom: "2026-10-31", rangeTo: "2026-10-01" }, { rangeKind: "rolling" }, { rangeKind: "rolling", rollingDays: 0 }, { email: "not-an-email" }, { expiresAt: "soon" }])
      expect([JSON.stringify(bad), (await w.owner.post("/report-grants", grantBody(bad))).status]).toEqual([JSON.stringify(bad), 400]);
    expect((await w.owner.post("/report-grants", grantBody({ locationIds: [randomUUID()] }))).status).toBe(404);
  });
  it("revoking and expiry end access at once and the screen can say who gave it; a grant can't be edited or deleted", async () => {
    await seed(); const id = await grant(); const expired = await grant({ email: "late@accounts.test", expiresAt: new Date(Date.now() - 60_000).toISOString() }); const reader = await signIn(); const late = await signIn("late@accounts.test");
    expect((await reader.get(`/portal/grants/${id}/reports/sales`)).status).toBe(200);
    const mine = (await reader.get("/portal/grants")).body; expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ status: "active", grantedBy: "Owner", locations: ["Fitzroy"], hiddenColumns: ["costMinor"], window: { from: "2026-10-01", to: "2026-10-31" } });
    expect((await w.owner.post(`/report-grants/${id}/revoke`)).status).toBe(200); expect((await w.owner.post(`/report-grants/${id}/revoke`)).status).toBe(409);
    const gone = await reader.get(`/portal/grants/${id}/reports/sales`); expect(gone.status).toBe(410); expect(gone.body).toMatchObject({ code: "access_ended", reason: "revoked", grantedBy: "Owner" });
    expect((await reader.get("/portal/grants")).body[0]).toMatchObject({ status: "revoked", endedReason: "revoked" });
    const l = await late.get(`/portal/grants/${expired}/reports/sales`); expect(l.status).toBe(410); expect(l.body.reason).toBe("expired");
    expect((await reader.get(`/portal/grants/${id}/reports/sales?format=csv`)).status).toBe(410);
    await expect(h.db.execute(sql`update shelfline.report_grant set hidden_columns = '{}' where id = ${id}`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.report_grant where id = ${id}`)).rejects.toThrow();
    expect((await w.owner.get("/audit?action=report_grant.revoke")).body.length).toBe(1); expect((await w.owner.get("/audit?action=report_grant.create")).body.length).toBe(2);
  });
  it("every view is logged with what was asked and what was served, and the log cannot be changed", async () => {
    await seed(); const id = await grant(); const reader = await signIn();
    await reader.get(`/portal/grants/${id}/reports/sales` + q({ from: "2026-01-01", to: "2026-12-31", groupBy: "product" })); await reader.get(`/portal/grants/${id}/reports/sales` + q({ format: "csv" })); await reader.get(`/portal/grants/${id}/reports/sales` + q({ locationId: w.southYarra.id }));   // refused: not logged
    const views = (await w.owner.get(`/report-grants/${id}/views`)).body; expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ reportKey: "sales", format: "json", requested: { from: "2026-01-01", to: "2026-12-31", groupBy: "product" }, served: { from: "2026-10-01", to: "2026-10-31", clamped: true, hidden: ["costMinor", "marginMinor"] } }); expect(views[0].format).toBe("csv");
    const list = (await w.owner.get("/report-grants")).body[0]; expect(list).toMatchObject({ grantee: "Ines Walker", status: "active", views: 2 });
    expect((await w.owner.get("/audit?action=portal.report.view")).body).toHaveLength(2);
    await expect(h.db.execute(sql`update shelfline.report_view_log set row_count = 0`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.report_view_log`)).rejects.toThrow();
    expect((await w.owner.get(`/report-grants/${id}/preview/sales`)).status).toBe(200); expect((await w.owner.get(`/report-grants/${id}/views`)).body).toHaveLength(2);       // a preview is not a view
  });
  it("one reader can hold several grants and sees only their own", async () => {
    await seed(); const a = await grant(); const b = await grant({ locationIds: [w.southYarra.id], hiddenColumns: [] }); const other = await grant({ email: "other@accounts.test" }); const reader = await signIn();
    expect((await reader.get("/portal/grants")).body.map((g: { id: string }) => g.id).sort()).toEqual([a, b].sort());
    expect((await reader.get(`/portal/grants/${other}/reports/sales`)).status).toBe(404); expect((await reader.get(`/portal/grants/${b}/reports/sales` + q({ groupBy: "location" }))).body.rows.map((r: { label: string }) => r.label)).toEqual(["South Yarra"]);
  });
  it("the mailbox is a development tool and says nothing in production mode", async () => {
    await grant(); expect((await mailbox("ines@accounts.test")).length).toBe(1);
    const { loadConfig } = await import("../src/config"); expect(loadConfig({ ...process.env, DEV_MAILBOX: undefined }).devMailbox).toBe(false);
  });
});
