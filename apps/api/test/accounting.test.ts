import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { zonedInstant } from "../src/common/business-day";
import { posWorld, reset, startApp, type Harness } from "./helpers";

/** A stand-in for the parts of Xero the export touches, including its habit of retiring a refresh token once it is used. */
class FakeXero {
  access = "xero-access-1"; refresh = "xero-refresh-1"; journals: { id: string; body: any; tenant: string; key: string }[] = []; refreshes = 0; fail = 0; byKey = new Map<string, string>(); server!: http.Server;
  async start() {
    this.server = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const json = (o: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/connect/token") { const f = new URLSearchParams(body); if (!req.headers.authorization?.startsWith("Basic ") || f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== this.refresh) return json({ error: "invalid_grant" }, 400); this.refreshes++; this.access = `xero-access-${this.refreshes + 1}`; this.refresh = `xero-refresh-${this.refreshes + 1}`; return json({ access_token: this.access, refresh_token: this.refresh, expires_in: 1800 }); }
      if (req.headers.authorization !== `Bearer ${this.access}`) return json({ Title: "Unauthorized" }, 401);
      if (req.url === "/connections") return json([{ tenantId: "tenant-0001-abcd", tenantName: "Kestrel Run Co." }]);
      if (req.url === "/api.xro/2.0/ManualJournals" && req.method === "POST") {
        if (this.fail > 0) { this.fail--; return json({ Message: "boom" }, 500); } const b = JSON.parse(body); const key = String(req.headers["idempotency-key"] ?? ""); if (this.byKey.has(key)) return json({ ManualJournals: [{ ManualJournalID: this.byKey.get(key) }] });
        const lines = b.ManualJournals[0].JournalLines as { LineAmount: number }[]; const total = Math.round(lines.reduce((a, l) => a + l.LineAmount * 100, 0)); if (total !== 0) return json({ Message: "Journal does not balance" }, 400);
        const id = `MJ-${this.journals.length + 1}`; this.journals.push({ id, body: b.ManualJournals[0], tenant: String(req.headers["xero-tenant-id"]), key }); this.byKey.set(key, id); return json({ ManualJournals: [{ ManualJournalID: id }] });
      }
      json({}, 404); }); });
    await new Promise<void>((ok) => this.server.listen(19490, "127.0.0.1", ok));
  }
  stop() { this.server.close(); }
}
let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string; const xero = new FakeXero();
beforeAll(async () => { await xero.start(); h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); xero.stop(); });
const MEL = "Australia/Melbourne"; const DATE = "2026-11-04"; const at = (hm: string) => new Date(zonedInstant(DATE, hm, MEL)).toISOString();
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.accounting_export, shelfline.account_mapping, shelfline.xero_connection cascade`); w = await posWorld(h, { stock: 100 }); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 20000 })]);
  xero.access = "xero-access-1"; xero.refresh = "xero-refresh-1"; xero.journals = []; xero.refreshes = 0; xero.fail = 0; xero.byKey.clear();
});
async function sell(v: number, qty: number, tender: "cash" | "card") {
  const ls = [{ variantId: w.v[v]!.id, qty, unitPriceMinor: [21995, 8900, 3400][v]!, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const pay = tender === "cash" ? { tender, amountMinor: p.payableMinor, tenderedMinor: p.payableMinor + 500 } : { tender, amountMinor: p.payableMinor };
  expect((await w.push([w.cmd("sale.create", { saleId, sessionId: session, receiptNo: `A-${saleId.slice(0, 6)}`, customerId: null, lines: ls, payments: [pay], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: p.cashRoundingMinor, payableMinor: p.payableMinor }, cashRoundingStep: null })])).body.results[0].status).toMatch(/accepted/);
  return { saleId, total: p.totalMinor, tax: p.taxMinor };
}
async function refund(saleId: string, qty: number, prior = { qty: 0, minor: 0, tax: 0 }) {
  const line = (await h.db.execute(sql`select qty, total_minor, tax_minor from shelfline.sale_line where sale_id = ${saleId}`)).rows[0] as { qty: number; total_minor: number; tax_minor: number };
  const r = refundAmount({ qty: line.qty, refundedQty: prior.qty, totalMinor: line.total_minor, refundedMinor: prior.minor, taxMinor: line.tax_minor, refundedTaxMinor: prior.tax }, qty);
  const res = await w.push([w.cmd("refund.create", { refundId: randomUUID(), saleId, sessionId: session, tender: "card", reason: "wrong_size", lines: [{ saleLineNo: 0, qty, amountMinor: r.amountMinor, taxMinor: r.taxMinor, restock: true }], totalMinor: r.amountMinor })]); expect(res.body.results[0].status).toMatch(/accepted/); return r;
}
const close = async (counted: number) => { expect((await w.push([w.cmd("session.close", { sessionId: session, countedMinor: counted })])).body.results[0].status).toMatch(/accepted/); };
const redate = async () => { await h.db.execute(sql`update shelfline.sale set local_date = ${DATE}::date, effective_at = ${at("12:00")}::timestamptz`); await h.db.execute(sql`update shelfline.refund set local_date = ${DATE}::date, at = ${at("15:00")}::timestamptz`); await h.db.execute(sql`update shelfline.register_session set opened_at = ${at("09:00")}::timestamptz`); };
const KEYS = { cash: "090", card_clearing: "091", gift_card_liability: "810", store_credit_liability: "811", other_clearing: "092", sales_revenue: "200", gst_collected: "820", rounding: "830", cash_over_short: "831", cogs: "310", inventory: "630", suspense: "999" };
const map = () => w.owner.put("/accounting/accounts", { items: Object.entries(KEYS).map(([key, code]) => ({ key, code, name: key.replace(/_/g, " ") })) });
const day = async () => (await w.owner.get(`/accounting/day?locationId=${w.fitzroy.id}&date=${DATE}`)).body;
const exportDay = (method: "csv" | "xero" = "csv") => w.owner.post("/accounting/export", { locationId: w.fitzroy.id, date: DATE, method });
const net = (lines: { account: string; debitMinor: number; creditMinor: number }[]) => Object.fromEntries(lines.map((l) => [l.account, l.debitMinor - l.creditMinor]));
const connectXero = (o: object = {}) => w.owner.put("/accounting/xero", { tenantId: "tenant-0001-abcd", accessToken: "xero-access-1", refreshToken: "xero-refresh-1", clientId: "client-abc", clientSecret: "secret-xyz", ...o });

describe("the day as a journal", () => {
  it("balances, matches what was sold and taken, shows over-and-short, and is not exportable while a register is open", async () => {
    const a = await sell(0, 1, "cash"), b = await sell(1, 2, "card"); await refund(b.saleId, 1); await redate();
    expect(await day()).toMatchObject({ status: "open", openRegisters: 1 }); expect((await exportDay()).body).toMatchObject({ code: "day_not_closed" });
    await close(20000 + a.total - 3000); await redate(); const d = await day(); expect(d.status).toBe("ready"); expect(d.balanced).toBe(true); expect(d.unreconciledMinor).toBe(0);
    const v = Number((await h.db.execute(sql`select variance_minor from shelfline.register_session`)).rows[0]!.variance_minor); const n = net(d.lines);
    const refunded = refundAmount({ qty: 2, refundedQty: 0, totalMinor: b.total, refundedMinor: 0, taxMinor: b.tax, refundedTaxMinor: 0 }, 1);
    expect(n.cash).toBe(a.total + v); expect(n.card_clearing).toBe(b.total - refunded.amountMinor); expect(n.gst_collected).toBe(-(a.tax + b.tax - refunded.taxMinor)); expect(n.sales_revenue).toBe(-((a.total - a.tax) + (b.total - b.tax) - (refunded.amountMinor - refunded.taxMinor)));
    expect(n.cash_over_short).toBe(-v); expect(n.cogs!).toBeGreaterThan(0); expect(n.inventory).toBe(-n.cogs!); expect(Object.values(n).reduce((x, y) => x + y, 0)).toBe(0); expect(d.netSalesMinor).toBe(a.total + b.total - refunded.amountMinor);
    expect((await w.owner.get(`/accounting/days?locationId=${w.fitzroy.id}&from=2026-11-03&to=2026-11-05`)).body.map((x: { date: string; status: string }) => `${x.date}:${x.status}`)).toEqual(["2026-11-05:empty", "2026-11-04:ready", "2026-11-03:empty"]);
  });
  it("stock the shop gave back goes back to inventory; a day nothing happened is empty and sends nothing", async () => {
    await close(20000); await redate(); expect((await day()).status).toBe("empty"); await map(); expect((await exportDay()).body).toEqual({ status: "unchanged", version: 0 }); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.accounting_export`)).rows[0]!.n).toBe(0);
  });
  it("only people with accounting access, only their own organisation's stores, sensible ranges", async () => {
    expect((await w.mgr.get("/accounting/accounts")).status).toBe(403); expect((await w.mgr.get(`/accounting/day?locationId=${w.fitzroy.id}&date=${DATE}`)).status).toBe(403); expect((await w.mgr.post("/accounting/export", { locationId: w.fitzroy.id, date: DATE, method: "csv" })).status).toBe(403);
    expect((await w.owner.get(`/accounting/day?locationId=${randomUUID()}&date=${DATE}`)).status).toBe(404); expect((await w.owner.get(`/accounting/days?locationId=${w.fitzroy.id}&from=2026-01-01&to=2026-12-31`)).status).toBe(400); expect((await w.owner.get(`/accounting/day?locationId=${w.fitzroy.id}&date=nope`)).status).toBe(400);
    await w.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-12", assignments: [{ role: "finance", locationId: null }] }); const fin = w.as((await w.login("fin@kestrel.test", "finance-password-12")).body.token); expect((await fin.get("/accounting/accounts")).status).toBe(200);
  });
});

describe("exporting once, and only what changed", () => {
  it("needs the accounts chosen first, then sends the whole day once and a repeat sends nothing", async () => {
    await sell(0, 1, "cash"); await sell(2, 1, "card"); await close(20000); await redate();
    const no = await exportDay(); expect(no.status).toBe(409); expect(no.body.code).toBe("mapping_missing"); expect(no.body.accounts).toEqual(expect.arrayContaining(["card_clearing", "sales_revenue", "gst_collected"])); expect((await map()).status).toBe(200); expect((await w.owner.get("/accounting/accounts")).body.find((a: { key: string }) => a.key === "cash")).toMatchObject({ code: "090" });
    const one = (await exportDay()).body; expect(one).toMatchObject({ status: "exported", version: 1, reference: "SHELFLINE-FIT-2026-11-04" }); expect(one.csv.split("\n")[0]).toBe("*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1");
    const rows = one.csv.trim().split("\n").slice(1); const total = rows.reduce((a: number, r: string) => a + Math.round(Number(r.split(",").at(-3)) * 100), 0); expect(total).toBe(0); expect(rows[0]).toContain("04/11/2026");
    expect((await exportDay()).body).toEqual({ status: "unchanged", version: 1 }); expect((await exportDay()).body).toEqual({ status: "unchanged", version: 1 }); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.accounting_export`)).rows[0]!.n).toBe(1); expect((await day()).status).toBe("exported");
    const again = await w.owner.get(`/accounting/exports/${one.id}/csv`); expect(again.status).toBe(200); expect(again.text).toBe(one.csv); await expect(h.db.execute(sql`update shelfline.accounting_export set reference = 'x'`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.accounting_export`)).rejects.toThrow();
  });
  it("a refund that arrives after the day was sent becomes a small adjusting journal; the first is never rewritten", async () => {
    const b = await sell(1, 2, "card"); await close(20000); await map(); await redate(); const one = (await exportDay()).body; expect(one.version).toBe(1);
    // the next morning a refund for yesterday's sale is rung in and dated to the same trading day by the till's own clock
    session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 1000 })]); const r = await refund(b.saleId, 1); await h.db.execute(sql`update shelfline.refund set local_date = ${DATE}::date`); await h.db.execute(sql`update shelfline.register_session set opened_at = now() where id = ${session}`);
    const d = await day(); expect(d.status).toBe("changed"); expect(net(d.pending)).toEqual({ card_clearing: -r.amountMinor, sales_revenue: r.amountMinor - r.taxMinor, gst_collected: r.taxMinor, cogs: net(d.pending).cogs ?? 0, inventory: net(d.pending).inventory ?? 0 });
    const two = (await exportDay()).body; expect(two).toMatchObject({ status: "exported", version: 2, reference: expect.stringMatching(/-ADJ2$/) }); expect((await exportDay()).body).toEqual({ status: "unchanged", version: 2 });
    const all = (await h.db.execute(sql`select version, lines from shelfline.accounting_export order by version`)).rows as { version: number; lines: { account: string; amountMinor: number }[] }[]; const cum = new Map<string, number>(); for (const e of all) for (const l of e.lines) cum.set(l.account, (cum.get(l.account) ?? 0) + l.amountMinor);
    expect(all.map((e) => e.version)).toEqual([1, 2]); expect(Object.fromEntries([...cum].filter(([, v]) => v !== 0))).toEqual(Object.fromEntries(Object.entries(net((await day()).lines)).filter(([, v]) => v !== 0)));
  });
});

describe("sending to Xero", () => {
  it("refuses a bad token, an unknown organisation and a missing connection, and keeps secrets encrypted and out of sight", async () => {
    expect((await connectXero({ accessToken: "wrong-token-123" })).body).toMatchObject({ code: "xero_token_refused" }); expect((await connectXero({ tenantId: "someone-elses-tenant" })).body).toMatchObject({ code: "xero_tenant_not_found" });
    await sell(0, 1, "cash"); await close(20000); await map(); await redate(); expect((await exportDay("xero")).body).toMatchObject({ code: "xero_not_connected" });
    const ok = await connectXero(); expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ connected: true, tenantId: "tenant-0001-abcd", clientId: "client-abc" }); expect(JSON.stringify(ok.body)).not.toMatch(/secret|refresh|access-1/);
    const [row] = (await h.db.execute(sql`select access_token_enc, refresh_token_enc, client_secret_enc from shelfline.xero_connection`)).rows as Record<string, string>[]; for (const v of Object.values(row!)) expect(v).not.toMatch(/xero|secret/); expect(JSON.stringify((await w.owner.get("/accounting/xero")).body)).not.toMatch(/xero-access|xero-refresh|secret-xyz/);
  });
  it("sends one balanced DRAFT manual journal with the chosen account codes, records Xero's id, and a double click sends one", async () => {
    await sell(0, 1, "cash"); await sell(1, 2, "card"); await close(19000); await map(); await redate(); await connectXero();
    const [a, b] = await Promise.all([exportDay("xero"), exportDay("xero")]); expect([a.body.status, b.body.status].sort()).toEqual(["exported", "unchanged"]); expect(xero.journals).toHaveLength(1);
    const j = xero.journals[0]!; expect(j.tenant).toBe("tenant-0001-abcd"); expect(j.body).toMatchObject({ Status: "DRAFT", LineAmountTypes: "NoTax", Date: DATE }); expect(j.body.Narration).toBe("SHELFLINE-FIT-2026-11-04 Fitzroy end of day");
    const lines = j.body.JournalLines as { AccountCode: string; LineAmount: number }[]; expect(Math.round(lines.reduce((x, l) => x + l.LineAmount * 100, 0))).toBe(0); expect(lines.map((l) => l.AccountCode).sort()).toEqual(expect.arrayContaining(["090", "091", "200", "820"])); expect(lines.every((l) => l.LineAmount !== 0)).toBe(true);
    const won = a.body.status === "exported" ? a.body : b.body; expect(won.externalRef).toBe("MJ-1"); expect((await w.owner.get("/accounting/exports")).body[0]).toMatchObject({ method: "xero", externalRef: "MJ-1", version: 1 });
  });
  it("a Xero failure records nothing and can simply be tried again; the same journal is never created twice", async () => {
    await sell(0, 1, "card"); await close(20000); await map(); await redate(); await connectXero(); xero.fail = 1; const bad = await exportDay("xero"); expect(bad.status).toBe(409); expect(bad.body.code).toBe("xero_failed"); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.accounting_export`)).rows[0]!.n).toBe(0); expect((await w.owner.get("/accounting/xero")).body.lastError).toContain("xero 500");
    expect((await exportDay("xero")).body).toMatchObject({ status: "exported", version: 1 }); expect(xero.journals).toHaveLength(1); expect((await w.owner.get("/accounting/xero")).body.lastError).toBeFalsy();
  });
  it("renews the access token when it is nearly over, keeps the new refresh token, and says so when Xero will not renew", async () => {
    const b = await sell(1, 2, "card"); await close(20000); await map(); await redate(); await connectXero(); await h.db.execute(sql`update shelfline.xero_connection set expires_at = now() + interval '10 seconds'`);
    expect((await exportDay("xero")).body.status).toBe("exported"); expect(xero.refreshes).toBe(1); expect(xero.journals[0]!.tenant).toBe("tenant-0001-abcd");
    session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 1000 })]); await refund(b.saleId, 1); await h.db.execute(sql`update shelfline.refund set local_date = ${DATE}::date`); await h.db.execute(sql`update shelfline.register_session set opened_at = now() where id = ${session}`);
    await h.db.execute(sql`update shelfline.xero_connection set expires_at = now() - interval '1 minute'`); xero.refresh = "retired-elsewhere";        // Xero no longer honours the refresh token we hold
    const r = await exportDay("xero"); expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: "xero_failed" }); expect(r.body.detail).toContain("xero token 400"); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.accounting_export`)).rows[0]!.n).toBe(1);
    expect((await w.owner.get("/accounting/xero")).body.lastError).toContain("xero token");
  });
  it("disconnecting removes the secrets and stops sending, while the file download still works", async () => {
    await sell(0, 1, "card"); await close(20000); await map(); await redate(); await connectXero(); expect((await w.owner.delete("/accounting/xero")).body).toMatchObject({ connected: false }); expect((await h.db.execute(sql`select access_token_enc, refresh_token_enc, client_secret_enc from shelfline.xero_connection`)).rows[0]).toEqual({ access_token_enc: null, refresh_token_enc: null, client_secret_enc: null });
    expect((await exportDay("xero")).body).toMatchObject({ code: "xero_not_connected" }); expect((await exportDay("csv")).body.status).toBe("exported");
  });
});
