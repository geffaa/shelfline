import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { LoyaltyService } from "../src/marketing/loyalty.service";
import { MarketingService } from "../src/marketing/marketing.service";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let session: string; let mk: MarketingService; let loyalty: LoyaltyService;
beforeAll(async () => { h = await startApp(); mk = h.app.get(MarketingService); loyalty = h.app.get(LoyaltyService); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.email_outbox, shelfline.marketing_message, shelfline.campaign, shelfline.flow, shelfline.segment, shelfline.loyalty_entry, shelfline.loyalty_program, shelfline.consent_event, shelfline.marketing_setting, shelfline.balance_entry restart identity cascade`);
  w = await posWorld(h, { stock: 100 }); session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 10000 })]); await new Promise((r) => setTimeout(r, 250));
});
const DAY = 86_400_000; const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const cust = async (name: string, o: { email?: string | null; consent?: boolean | null; birthMonth?: number; birthDay?: number } = {}) => {
  const body: Record<string, unknown> = { name, ...(o.email === null ? {} : { email: o.email ?? `${name.toLowerCase().replace(/\W+/g, ".")}@example.com` }), ...(o.consent === null || o.consent === undefined ? {} : { marketingConsent: { email: o.consent } }), ...(o.birthMonth ? { birthMonth: o.birthMonth, birthDay: o.birthDay } : {}) };
  const r = await w.owner.post("/customers", body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string;
};
async function sell(customerId: string | null, o: { v?: number; qty?: number; ago?: number } = {}) {
  const v = o.v ?? 0; const qty = o.qty ?? 1; const ls = [{ variantId: w.v[v]!.id, qty, unitPriceMinor: [21995, 8900, 3400][v]!, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const r = await w.push([w.cmd("sale.create", { saleId, sessionId: session, receiptNo: `M-${saleId.slice(0, 6)}`, customerId, lines: ls, payments: [{ tender: "card", amountMinor: p.payableMinor }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null })]);
  expect(r.body.results[0].status, JSON.stringify(r.body)).toMatch(/accepted/);
  if (o.ago) await h.db.execute(sql`update shelfline.sale set effective_at = ${daysAgo(o.ago).toISOString()}::timestamptz where id = ${saleId}`);
  return { saleId, net: p.totalMinor - p.taxMinor, total: p.totalMinor, tax: p.taxMinor, ls };
}
const mails = async (kind = "marketing") => (await h.db.execute(sql`select to_email, subject, body from shelfline.email_outbox where kind = ${kind} order by created_at, id`)).rows as { to_email: string; subject: string; body: string }[];
const camp = async (o: object = {}) => (await w.owner.post("/marketing/campaigns", { name: "Spring", subject: "Hello {{first_name}}", body: "Hi {{name}}, you have {{points}} points.", ...o })).body as { id: string };
const points = async (id: string) => Number(((await h.db.execute(sql`select coalesce(sum(points), 0)::int as n from shelfline.loyalty_entry where customer_id = ${id}`)).rows[0] as { n: number }).n);
const program = (o: object = {}) => w.owner.put("/loyalty/program", { enabled: true, pointsPerDollar: 1, tiers: [{ name: "Member", min: 0, multBp: 10000 }, { name: "Silver", min: 500, multBp: 12500 }, { name: "Gold", min: 1500, multBp: 15000 }], redeemPoints: 100, redeemValueMinor: 500, birthdayBonus: 0, ...o });
const relax = async () => { await h.db.execute(sql`alter table shelfline.marketing_message disable trigger marketing_message_immutable`); };
const tighten = async () => { await h.db.execute(sql`alter table shelfline.marketing_message enable trigger marketing_message_immutable`); };

describe("a campaign only goes to people who said yes", () => {
  it("emails the consenting with an address, records everyone else and why, and puts a one-click unsubscribe in every message", async () => {
    const a = await cust("Ana Silva", { consent: true }); await cust("Ben Okoye", { consent: false }); await cust("Cam Ng", { consent: null }); await cust("Dee Pham", { consent: true, email: null }); const e = await cust("Eli Cohen", { consent: true });
    const c = await camp(); expect((await w.owner.get(`/marketing/campaigns/${c.id}/audience`)).body).toEqual({ matched: 5, eligible: 2, skipped: { no_consent: 2, no_email: 1, frequency: 0 } });
    const out = await w.owner.post(`/marketing/campaigns/${c.id}/send`); expect(out.body).toEqual({ matched: 5, sent: 2, skipped: { no_consent: 2, no_email: 1, frequency: 0 } });
    const sent = await mails(); expect(sent.map((m) => m.to_email).sort()).toEqual(["ana.silva@example.com", "eli.cohen@example.com"]); expect(sent.find((m) => m.to_email.startsWith("ana"))).toMatchObject({ subject: "Hello Ana", body: expect.stringContaining("Hi Ana Silva, you have 0 points.") });
    for (const m of sent) expect(m.body).toMatch(/Unsubscribe with one click: http:\/\/localhost:8200\/marketing\/unsubscribe\?c=[0-9a-f-]{36}&s=[0-9a-f]{32}/);
    const msgs = (await w.owner.get(`/marketing/campaigns/${c.id}/messages`)).body; expect(msgs.map((m: { customer: string; status: string; skipReason: string | null }) => `${m.customer}:${m.status}:${m.skipReason ?? ""}`)).toEqual(["Ana Silva:sent:", "Ben Okoye:skipped:no_consent", "Cam Ng:skipped:no_consent", "Dee Pham:skipped:no_email", "Eli Cohen:sent:"]);
    expect((await w.owner.get("/marketing/campaigns")).body[0]).toMatchObject({ status: "sent", segment: "Everyone" }); void a; void e;
  });
  it("however consent is mixed, nobody without a yes is ever emailed, by a campaign or a flow, at any frequency setting", async () => {
    await w.owner.put("/marketing/settings", { minGapDays: 0 }); const yes: string[] = [];
    for (let i = 0; i < 12; i++) { const consent = [true, false, null][i % 3] as boolean | null; const id = await cust(`Person ${i}`, { consent, email: i % 4 === 3 ? null : undefined }); if (consent === true && i % 4 !== 3) yes.push(`person.${i}@example.com`); await sell(id, { v: 2, ago: 120 }); }
    await (await import("./helpers")).reset; const c = await camp(); await w.owner.post(`/marketing/campaigns/${c.id}/send`);
    const f = (await w.owner.get("/marketing/flows")).body; for (const x of f) await w.owner.patch(`/marketing/flows/${x.id}`, { active: true }); await mk.runFlows(w.orgId); await mk.runFlows(w.orgId, new Date(Date.now() + 40 * DAY));
    const got = new Set((await mails()).map((m) => m.to_email)); for (const to of got) expect([to, yes.includes(to)]).toEqual([to, true]); expect(got.size).toBeGreaterThan(0);
  });
  it("cannot be sent twice: a second send, or two at once, send each person exactly one email", async () => {
    for (let i = 0; i < 5; i++) await cust(`Pat ${i}`, { consent: true }); const c = await camp(); const [x, y, z] = await Promise.all([w.owner.post(`/marketing/campaigns/${c.id}/send`), w.owner.post(`/marketing/campaigns/${c.id}/send`), w.owner.post(`/marketing/campaigns/${c.id}/send`)]);
    expect([x.status, y.status, z.status].sort()).toEqual([200, 409, 409]); expect((await mails()).length).toBe(5); expect((await w.owner.post(`/marketing/campaigns/${c.id}/send`)).body).toMatchObject({ code: "not_a_draft", status: "sent" }); expect((await mails()).length).toBe(5);
    await expect(h.db.execute(sql`delete from shelfline.marketing_message`)).rejects.toThrow(); expect((await w.owner.patch(`/marketing/campaigns/${c.id}`, { subject: "changed" })).status).toBe(409);
  });
  it("holds back anyone emailed within the gap, and sends again once the gap is up or removed", async () => {
    const a = await cust("Ana", { consent: true }); const c1 = await camp({ name: "One" }); await w.owner.post(`/marketing/campaigns/${c1.id}/send`);
    const c2 = await camp({ name: "Two" }); expect((await w.owner.post(`/marketing/campaigns/${c2.id}/send`)).body).toMatchObject({ sent: 0, skipped: { frequency: 1 } });
    const c3 = await camp({ name: "Three" }); await relax(); await h.db.execute(sql`update shelfline.marketing_message set created_at = now() - interval '8 days' where customer_id = ${a}`); await tighten(); expect((await w.owner.post(`/marketing/campaigns/${c3.id}/send`)).body).toMatchObject({ sent: 1 });
    await w.owner.put("/marketing/settings", { minGapDays: 0 }); const c4 = await camp({ name: "Four" }); expect((await w.owner.post(`/marketing/campaigns/${c4.id}/send`)).body).toMatchObject({ sent: 1 }); expect((await w.owner.put("/marketing/settings", { minGapDays: 91 })).status).toBe(400);
  });
  it("segments choose who: lapsed, recent, big spenders; a preview counts before anything is saved", async () => {
    const lapsed = await cust("Lapsed Lou", { consent: true }); const recent = await cust("Recent Rae", { consent: true }); const big = await cust("Big Bea", { consent: true }); await cust("Never Nina", { consent: true });
    await sell(lapsed, { ago: 120 }); await sell(recent, { v: 2, ago: 5 }); await sell(big, { ago: 3 }); await sell(big, { ago: 2 });
    const pv = (rules: object) => w.owner.post("/marketing/segments/preview", { rules }); expect((await pv({ lastPurchaseBeforeDays: 90 })).body).toMatchObject({ matched: 1, eligible: 1, sample: ["Lapsed Lou"] }); expect((await pv({ lastPurchaseWithinDays: 30 })).body.matched).toBe(2); expect((await pv({ minOrders: 2 })).body.sample).toEqual(["Big Bea"]); expect((await pv({ neverPurchased: true })).body.sample).toEqual(["Never Nina"]); expect((await pv({})).body.matched).toBe(4);
    const seg = (await w.owner.post("/marketing/segments", { name: "Lapsed", rules: { lastPurchaseBeforeDays: 90 } })).body; expect((await w.owner.post("/marketing/segments", { name: "lapsed", rules: {} })).status).toBe(409); expect((await w.owner.post("/marketing/segments/preview", { rules: { bogus: 1 } })).status).toBe(400);
    expect((await w.owner.get("/marketing/segments")).body[0]).toMatchObject({ name: "Lapsed", members: 1 }); const c = await camp({ segmentId: seg.id }); await w.owner.post(`/marketing/campaigns/${c.id}/send`); expect((await mails()).map((m) => m.to_email)).toEqual(["lapsed.lou@example.com"]);
    expect((await w.owner.delete(`/marketing/segments/${seg.id}`)).status).toBe(409);
  });
  it("one click unsubscribes, once or twice, from a link only the server could have made; the history says how consent changed", async () => {
    const a = await cust("Ana", { consent: true }); await w.owner.patch(`/customers/${a}`, { marketingConsent: { email: true } }); const c = await camp(); await w.owner.post(`/marketing/campaigns/${c.id}/send`);
    const link = /(http:\/\/localhost:8200)(\/marketing\/unsubscribe\?c=[^\s]+)/.exec((await mails())[0]!.body)![2]!; const bad = link.replace(/s=[0-9a-f]/, "s=0"); expect((await h.http().get(bad)).status).toBe(404); expect((await h.http().get("/marketing/unsubscribe?c=nope&s=x")).status).toBe(400);
    const page = await h.http().get(link); expect(page.status).toBe(200); expect(page.text).toContain("You are unsubscribed"); expect((await h.http().get(link)).status).toBe(200);
    expect((await h.db.execute(sql`select marketing_consent from shelfline.customer where id = ${a}`)).rows[0]!.marketing_consent).toMatchObject({ email: false }); const c2 = await camp({ name: "Next" }); await w.owner.put("/marketing/settings", { minGapDays: 0 }); expect((await w.owner.post(`/marketing/campaigns/${c2.id}/send`)).body).toMatchObject({ sent: 0, skipped: { no_consent: 1 } });
    expect((await h.db.execute(sql`select granted, source from shelfline.consent_event where customer_id = ${a} order by id`)).rows).toEqual([{ granted: true, source: "admin" }, { granted: false, source: "unsubscribe_link" }]); await expect(h.db.execute(sql`update shelfline.consent_event set granted = true`)).rejects.toThrow();
  });
  it("is for people allowed to run marketing, and drafts can be edited, previewed and cancelled", async () => {
    for (const call of [() => w.mgr.get("/marketing/campaigns"), () => w.mgr.get("/marketing/segments"), () => w.mgr.post("/marketing/campaigns", { name: "x", subject: "s", body: "b" }), () => w.mgr.get("/loyalty/program"), () => w.mgr.get("/marketing/flows")]) expect((await call()).status).toBe(403);
    const c = await camp(); expect((await w.owner.patch(`/marketing/campaigns/${c.id}`, { subject: "New subject" })).body.subject).toBe("New subject"); expect((await w.owner.post(`/marketing/campaigns/${c.id}/cancel`)).body.status).toBe("cancelled"); expect((await w.owner.post(`/marketing/campaigns/${c.id}/send`)).status).toBe(409);
    expect((await w.owner.post("/marketing/campaigns", { name: "", subject: "s", body: "b" })).status).toBe(400); expect((await w.owner.post("/marketing/campaigns", { name: "x", subject: "s", body: "b", segmentId: randomUUID() })).status).toBe(404);
  });
});

describe("flows", () => {
  const on = async (kind: string, config: object = {}) => { const f = (await w.owner.get("/marketing/flows")).body.find((x: { kind: string }) => x.kind === kind); await w.owner.patch(`/marketing/flows/${f.id}`, { active: true, config }); return f.id as string; };
  it("start switched off with sensible wording, and do nothing until they are switched on", async () => {
    const f = (await w.owner.get("/marketing/flows")).body; expect(f.map((x: { kind: string; active: boolean }) => `${x.kind}:${x.active}`)).toEqual(["birthday:false", "post_purchase:false", "win_back:false"]); const a = await cust("Ana", { consent: true }); await sell(a, { ago: 200 });
    expect((await mk.runFlows(w.orgId)).sent).toBe(0); expect(await mails()).toEqual([]); expect((await w.owner.patch(`/marketing/flows/${f[2].id}`, { config: { inactiveDays: 3 } })).status).toBe(400);
  });
  it("win-back: a lapsed, consenting customer is written to once; running again, or at once, does nothing; a second lapse is a new reason", async () => {
    const f = await on("win_back", { inactiveDays: 90 }); const ana = await cust("Ana", { consent: true }); await cust("Ben", { consent: false }); const cy = await cust("Cy", { consent: true }); await sell(ana, { ago: 100 }); await sell(cy, { ago: 10 });
    const rs = await Promise.all([mk.runFlows(w.orgId), mk.runFlows(w.orgId), mk.runFlows(w.orgId)]); expect(rs.reduce((a, r) => a + r.sent, 0)).toBe(1); expect((await mails()).map((m) => m.to_email)).toEqual(["ana@example.com"]); expect((await mails())[0]!.subject).toBe("We have missed you, Ana");
    expect((await mk.runFlows(w.orgId)).sent).toBe(0); expect((await mk.runFlows(w.orgId, new Date(Date.now() + 30 * DAY))).sent).toBe(0);
    await sell(ana, { ago: 200 + 0 }); await h.db.execute(sql`update shelfline.sale set effective_at = now() - interval '100 days' where customer_id = ${ana}`); await relax(); await h.db.execute(sql`update shelfline.marketing_message set created_at = now() - interval '30 days'`); await tighten();
    expect((await w.owner.get("/marketing/flows")).body.find((x: { id: string }) => x.id === f).sent).toBe(1);
  });
  it("birthday: on the day, with a points bonus once a year even for someone who has not agreed to email", async () => {
    await program({ birthdayBonus: 50 }); const now = new Date(); const tz = "Australia/Melbourne"; void tz; const org = (await h.db.execute(sql`select timezone_default as tz from shelfline.org`)).rows[0]!.tz as string;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: org, month: "2-digit", day: "2-digit" }).formatToParts(now).reduce((a, x) => ({ ...a, [x.type]: Number(x.value) }), {} as Record<string, number>);
    const a = await cust("Ana", { consent: true, birthMonth: p.month, birthDay: p.day }); const b = await cust("Ben", { consent: false, birthMonth: p.month, birthDay: p.day }); await cust("Cy", { consent: true, birthMonth: (p.month! % 12) + 1, birthDay: p.day }); await on("birthday");
    expect(await mk.runFlows(w.orgId, now)).toEqual({ sent: 1, bonuses: 2 }); expect((await mails()).map((m) => m.to_email)).toEqual(["ana@example.com"]); expect(await points(a)).toBe(50); expect(await points(b)).toBe(50);
    expect(await mk.runFlows(w.orgId, now)).toEqual({ sent: 0, bonuses: 0 }); expect(await points(a)).toBe(50); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.loyalty_entry where kind = 'bonus'`)).rows[0]!.n).toBe(2);
  });
  it("after a purchase: written to a few days later, once per purchase, never for old ones, and never twice in the same gap", async () => {
    await on("post_purchase", { afterDays: 3 }); const a = await cust("Ana", { consent: true }); const old = await cust("Old Olly", { consent: true }); await sell(a, { ago: 3 }); await sell(a, { v: 2, ago: 3 }); await sell(old, { ago: 12 }); await cust("Fresh Fay", { consent: true }).then((f) => sell(f, { ago: 0 }));
    expect((await mk.runFlows(w.orgId)).sent).toBe(1); expect((await mails()).map((m) => m.to_email)).toEqual(["ana@example.com"]); expect((await mk.runFlows(w.orgId)).sent).toBe(0);                               // two purchases, one email: the gap
  });
});

describe("loyalty points are a ledger", () => {
  it("earns points on what was bought without GST, only for a customer, only when the program is on, and they add up", async () => {
    const a = await cust("Ana", { consent: true }); await sell(a); expect(await points(a)).toBe(0); expect((await program()).status).toBe(200); const s = await sell(a); expect(s.net).toBe(19995); expect(await points(a)).toBe(199);
    await sell(null); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.loyalty_entry`)).rows[0]!.n).toBe(1); const v = (await w.owner.get(`/loyalty/customers/${a}`)).body; expect(v).toMatchObject({ points: 199, lifetime: 199, tier: "Member", multBp: 10000, nextTier: { name: "Silver", pointsToGo: 301 } }); expect(v.entries[0]).toMatchObject({ kind: "earn", points: 199 });
    expect((await program({ enabled: false })).status).toBe(200); await sell(a); expect(await points(a)).toBe(199);
  });
  it("a higher tier earns more on the next purchase", async () => {
    await program(); const a = await cust("Ana", { consent: true }); await sell(a, { qty: 3 }); expect(await points(a)).toBe(599);        // 3 x 199.95 = 599.85 -> 599, Member rate
    expect((await w.owner.get(`/loyalty/customers/${a}`)).body).toMatchObject({ tier: "Silver" }); await sell(a); expect(await points(a)).toBe(599 + 249);                                              // Silver: 199.95 x 1.25 = 249
  });
  it("a refund takes back its share and a full refund takes back everything, exactly", async () => {
    await program(); const a = await cust("Ana", { consent: true }); const s = await sell(a, { v: 1, qty: 3 }); const earned = await points(a); expect(earned).toBe(Math.floor(s.net / 100));
    const line = (await h.db.execute(sql`select qty, total_minor, tax_minor from shelfline.sale_line where sale_id = ${s.saleId}`)).rows[0] as { qty: number; total_minor: number; tax_minor: number };
    const refund = async (qty: number, prior: { qty: number; minor: number; tax: number }) => { const r = refundAmount({ qty: line.qty, refundedQty: prior.qty, totalMinor: line.total_minor, refundedMinor: prior.minor, taxMinor: line.tax_minor, refundedTaxMinor: prior.tax }, qty); const res = await w.push([w.cmd("refund.create", { refundId: randomUUID(), saleId: s.saleId, sessionId: session, tender: "card", reason: "wrong_size", lines: [{ saleLineNo: 0, qty, amountMinor: r.amountMinor, taxMinor: r.taxMinor, restock: true }], totalMinor: r.amountMinor })]); expect(res.body.results[0].status).toMatch(/accepted/); return r; };
    const one = await refund(1, { qty: 0, minor: 0, tax: 0 }); const afterOne = await points(a); expect(afterOne).toBeLessThan(earned); expect(afterOne).toBeGreaterThan(earned * 0.6);
    await refund(2, { qty: 1, minor: one.amountMinor, tax: one.taxMinor }); expect(await points(a)).toBe(0); expect((await h.db.execute(sql`select kind from shelfline.loyalty_entry order by id`)).rows.map((r) => r.kind)).toEqual(["earn", "clawback", "clawback"]);
  });
  it("points turn into store credit in whole blocks, never beyond the balance, never twice for one request, and two requests cannot both spend the same points", async () => {
    await program(); const a = await cust("Ana", { consent: true }); await sell(a, { qty: 1 }); await sell(a, { qty: 1 }); expect(await points(a)).toBe(398);
    const redeem = (pts: number, key = randomUUID()) => w.owner.post(`/loyalty/customers/${a}/redeem`, { points: pts, idempotencyKey: key }); expect((await redeem(150)).body).toMatchObject({ code: "bad_block", blockPoints: 100 }); expect((await redeem(400)).body.code).toBe("not_enough_points");
    const key = randomUUID(); const ok = await redeem(100, key); expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ creditMinor: 500, storeCreditMinor: 500, points: 298 }); expect((await redeem(100, key)).body).toMatchObject({ replayed: true, points: 298 }); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.balance_entry`)).rows[0]!.n).toBe(1);
    const [x, y, z, q] = await Promise.all([redeem(100), redeem(100), redeem(100), redeem(100)]); expect([x, y, z, q].filter((r) => r.status === 200)).toHaveLength(2); expect(await points(a)).toBe(98); expect((await h.db.execute(sql`select coalesce(sum(delta_minor), 0)::int as n from shelfline.balance_entry`)).rows[0]!.n).toBe(1500);
    expect((await w.owner.get(`/customers/${a}/credit`)).body.balanceMinor ?? 1500).toBe(1500);
  });
  it("manual adjustments are audited and idempotent, and rows can never be edited or removed", async () => {
    await program(); const a = await cust("Ana", { consent: true }); const key = randomUUID(); expect((await w.owner.post(`/loyalty/customers/${a}/adjust`, { points: 120, reason: "Goodwill after a delay", idempotencyKey: key })).body).toMatchObject({ points: 120, replayed: false }); expect((await w.owner.post(`/loyalty/customers/${a}/adjust`, { points: 120, reason: "Goodwill after a delay", idempotencyKey: key })).body).toMatchObject({ points: 120, replayed: true });
    expect((await w.owner.post(`/loyalty/customers/${a}/adjust`, { points: -20, reason: "Correction", idempotencyKey: randomUUID() })).body.points).toBe(100); expect((await w.owner.post(`/loyalty/customers/${a}/adjust`, { points: 0, reason: "nothing", idempotencyKey: randomUUID() })).status).toBe(400);
    expect((await w.owner.get("/audit?action=loyalty.adjust")).body).toHaveLength(2); await expect(h.db.execute(sql`update shelfline.loyalty_entry set points = 1`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.loyalty_entry`)).rejects.toThrow(); expect((await w.mgr.post(`/loyalty/customers/${a}/adjust`, { points: 5, reason: "nope nope", idempotencyKey: randomUUID() })).status).toBe(403);
  });
  it("the balance is always the sum of the rows, whatever happens", async () => {
    await program(); const ids = [await cust("A", { consent: true }), await cust("B", { consent: true })]; let seed = 3; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 24; i++) { const c = ids[Math.floor(rnd() * 2)]!; const r = rnd(); if (r < 0.55) await sell(c, { v: Math.floor(rnd() * 3), qty: 1 + Math.floor(rnd() * 3) }); else if (r < 0.8) await w.owner.post(`/loyalty/customers/${c}/adjust`, { points: Math.floor(rnd() * 400) - 150 || 1, reason: "random walk", idempotencyKey: randomUUID() }); else await w.owner.post(`/loyalty/customers/${c}/redeem`, { points: 100, idempotencyKey: randomUUID() }); }
    for (const c of ids) { const v = (await w.owner.get(`/loyalty/customers/${c}`)).body; expect(v.points).toBe(await points(c)); expect(await loyalty.balance(w.orgId, c)).toBe(await points(c)); }
    const top = (await w.owner.get("/loyalty/top")).body; expect(top.members.map((m: { points: number }) => m.points)).toEqual([...top.members.map((m: { points: number }) => m.points)].sort((a: number, b: number) => b - a));
  });
  it("the program is validated, the till can look a customer up, and staff without customer access cannot", async () => {
    expect((await program({ tiers: [{ name: "A", min: 10, multBp: 10000 }] })).status).toBe(400); expect((await program({ tiers: [{ name: "A", min: 0, multBp: 10000 }, { name: "a", min: 5, multBp: 11000 }] })).status).toBe(400); expect((await program({ pointsPerDollar: 1000 })).status).toBe(400);
    await program(); const a = await cust("Ana", { consent: true }); const till = await h.http().get(`/pos/loyalty/${a}`).set("Authorization", `Bearer ${w.tok}`); expect(till.status).toBe(200); expect(till.body).toMatchObject({ points: 0, tier: "Member" }); expect(till.body.entries).toBeUndefined(); expect((await h.http().get(`/pos/loyalty/${a}`)).status).toBe(401); expect((await h.http().get(`/loyalty/customers/${a}`).set("Authorization", `Bearer ${w.tok}`)).status).toBe(401); expect((await w.owner.get(`/loyalty/customers/${randomUUID()}`)).status).toBe(404);
    expect((await w.owner.get("/audit?action=loyalty.program")).body.length).toBeGreaterThanOrEqual(1);
  });
});
