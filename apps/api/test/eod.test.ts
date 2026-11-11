import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { priceCart } from "@shelfline/pricing";
import { zonedInstant } from "../src/common/business-day";
import { EodService } from "../src/eod/eod.service";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let svc: EodService; let session: string | null;
beforeAll(async () => { h = await startApp(); svc = h.app.get(EodService); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.email_outbox, shelfline.scheduled_job, shelfline.eod_schedule restart identity cascade`); w = await posWorld(h, { stock: 50 }); session = null;
});
const PER = "Australia/Perth", MEL = "Australia/Melbourne"; const at = (date: string, hm: string, tz = MEL) => new Date(zonedInstant(date, hm, tz));
const open = async () => { session = randomUUID(); expect((await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 20000 })])).body.results[0].status).toBe("accepted"); };
const close = async (counted = 20000) => { expect((await w.push([w.cmd("session.close", { sessionId: session, countedMinor: counted })])).body.results[0].status).toMatch(/accepted/); };
async function sell(variant: number, qty: number, date: string) {
  const lines = [{ variantId: w.v[variant]!.id, qty, unitPriceMinor: [21995, 8900, 3400][variant]!, discountMinor: 0 }]; const priced = priceCart(lines.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
  const sale = { saleId, sessionId: session, receiptNo: `R-${saleId.slice(0, 6)}`, customerId: null, lines, payments: [{ tender: "card", amountMinor: priced.payableMinor }], totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null };
  expect((await w.push([w.cmd("sale.create", sale)])).body.results[0].status).toBe("accepted");
  await h.db.execute(sql`update shelfline.sale set local_date = ${date}::date where id = ${saleId}`); return priced.totalMinor;
}
/** A session is dated by when it was opened: move it to the business day in question. */
const dateSessions = (iso: string) => h.db.execute(sql`update shelfline.register_session set opened_at = ${iso}::timestamptz`);
const mk = async (o: object = {}) => { const r = await w.owner.post("/eod-schedules", { name: "Fitzroy close", locationIds: [w.fitzroy.id], sendAtLocal: "21:30", timezone: MEL, methods: ["email"], recipients: ["elena@kestrel.test"], format: "inline", onlyWhenClosed: true, maxWaitMinutes: 60, ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body as { id: string; webhookSecret?: string }; };
const runs = async () => (await h.db.execute(sql`select version, status, local_date::text as d, notes, delivered from shelfline.eod_report_run order by local_date, version`)).rows as { version: number; status: string; d: string; notes: string[]; delivered: { ok: boolean }[] }[];
const jobs = async () => (await h.db.execute(sql`select local_date::text as d, status, run_at from shelfline.scheduled_job order by run_at`)).rows as { d: string; status: string; run_at: Date }[];
const mails = async (kind = "eod_report") => (await h.db.execute(sql`select to_email, subject, body, attachment_name, attachment_type, attachment_base64 from shelfline.email_outbox where kind = ${kind} order by created_at`)).rows as { to_email: string; subject: string; body: string; attachment_name: string | null; attachment_type: string | null; attachment_base64: string | null }[];
const backdate = (id: string, iso = "2020-01-01T00:00:00Z") => h.db.execute(sql`update shelfline.eod_schedule set created_at = ${iso}::timestamptz where id = ${id}`);

describe("being sent at the right time, once", () => {
  it("21:30 in Perth is sent at 13:30 UTC and not before, and the report covers that Perth day", async () => {
    const perth = (await w.owner.post("/locations", { code: "fre", name: "Fremantle", type: "store", timezone: PER })).body; const s = await mk({ name: "Perth close", locationIds: [perth.id], timezone: PER }); await backdate(s.id, "2030-06-14T00:00:00Z");
    await svc.tick(new Date("2030-06-14T13:29:00Z")); expect(await jobs()).toHaveLength(0); expect(await mails()).toHaveLength(0);                       // 21:29 on the 14th in Perth: not yet
    await svc.tick(new Date("2030-06-14T13:30:00Z")); const j = await jobs(); expect(j).toHaveLength(1); expect(new Date(j[0]!.run_at).toISOString()).toBe("2030-06-14T13:30:00.000Z"); expect(j[0]).toMatchObject({ d: "2030-06-14", status: "done" });
    expect(await mails()).toHaveLength(1); expect((await mails())[0]).toMatchObject({ to_email: "elena@kestrel.test", subject: expect.stringContaining("Perth close") }); expect((await mails())[0]!.subject).toContain("14 June 2030");
  });
  it("keeps 21:30 on the wall clock across both Melbourne clock changes", async () => {
    const s = await mk({ name: "Melb", timezone: MEL }); await backdate(s.id);
    for (const [iso, d] of [["2027-04-03T10:30:00Z", "2027-04-03"], ["2027-04-04T11:30:00Z", "2027-04-04"], ["2027-10-03T10:30:00Z", "2027-10-03"]] as const) {
      await h.db.execute(sql`truncate table shelfline.eod_report_run, shelfline.scheduled_job cascade`);
      const before = new Date(Date.parse(iso) - 60_000); await svc.tick(before); expect((await jobs()).some((x) => x.d === d)).toBe(false);
      await svc.tick(new Date(iso)); const j = (await jobs()).find((x) => x.d === d)!; expect([d, new Date(j.run_at).toISOString()]).toEqual([d, new Date(iso).toISOString()]);
    }
  });
  it("a day's report is made once however many workers look, and again after a restart", async () => {
    const s = await mk(); await backdate(s.id); const now = at("2030-06-15", "21:30");
    const rs = await Promise.all([svc.tick(now), svc.tick(now), svc.tick(now), svc.tick(now)]); expect(rs.reduce((a, r) => a + r.ran, 0)).toBeLessThanOrEqual(2);       // today's and (at most) the one before it
    await svc.tick(now); await svc.tick(new Date(now.getTime() + 5 * 60_000));
    const j = await jobs(); expect(new Set(j.map((x) => x.d)).size).toBe(j.length); const r = await runs(); expect(r.filter((x) => x.d === "2030-06-15")).toHaveLength(1); expect((await mails()).filter((m) => /15 June 2030/.test(m.subject))).toHaveLength(1);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.scheduled_job where schedule_id = ${s.id} and local_date = '2030-06-15'`)).rows[0]!.n).toBe(1);
  });
  it("a schedule made after a day's send time does not report on that day, and a send time before the cutoff reports on the day before", async () => {
    const a = await mk(); await backdate(a.id, at("2030-06-15", "21:45").toISOString()); await svc.tick(at("2030-06-15", "21:50")); expect(await jobs()).toHaveLength(0);       // 21:30 had already passed when it was made
    const b = await mk({ name: "Early", sendAtLocal: "02:00" }); await backdate(b.id, at("2030-06-15", "12:00").toISOString()); await svc.tick(at("2030-06-16", "02:00"));
    const j = (await jobs()).filter((x) => new Date(x.run_at).getTime() === at("2030-06-16", "02:00").getTime()); expect(j).toHaveLength(1); expect(j[0]!.d).toBe("2030-06-15");               // 02:00 Sunday is still Saturday's trading day
  });
  it("only the chosen weekdays", async () => {
    const s = await mk({ daysOfWeek: [1] }); await backdate(s.id); await svc.tick(at("2030-06-16", "21:30")); expect((await jobs()).filter((x) => x.d === "2030-06-16")).toHaveLength(0);    // a Sunday
    await svc.tick(at("2030-06-17", "21:30")); expect((await jobs()).filter((x) => x.d === "2030-06-17")).toHaveLength(1);                                                                      // a Monday
  });
});

describe("waiting for registers to close, and saying so when it cannot", () => {
  it("holds the report while a register is open, then sends a labelled provisional one after the wait, then an amended one once things settle", async () => {
    await open(); await sell(0, 1, "2030-06-15"); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk({ maxWaitMinutes: 60 }); await backdate(s.id);
    const run = at("2030-06-15", "21:30"); await svc.tick(run); expect((await jobs()).find((x) => x.d === "2030-06-15")!.status).toBe("waiting"); expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(0);
    await svc.tick(new Date(run.getTime() + 59 * 60_000)); expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(0);
    await svc.tick(new Date(run.getTime() + 60 * 60_000)); const v1 = (await runs()).filter((r) => r.d === "2030-06-15"); expect(v1).toHaveLength(1); expect(v1[0]).toMatchObject({ version: 1, status: "provisional" }); expect(v1[0]!.notes.join(" ")).toContain("Still open after waiting");
    const m1 = (await mails()).filter((m) => /15 June 2030/.test(m.subject)); expect(m1[0]!.subject).toMatch(/^\[Provisional\]/); expect(m1[0]!.body).toContain("PROVISIONAL");
    await close(); await dateSessions(at("2030-06-15", "09:00").toISOString());
    await svc.tick(new Date(run.getTime() + 2 * 3_600_000)); const r2 = (await runs()).filter((r) => r.d === "2030-06-15"); expect(r2.map((r) => `${r.version}:${r.status}`)).toEqual(["1:provisional", "2:amended"]);
    expect((await mails()).filter((m) => /15 June 2030/.test(m.subject)).at(-1)!.subject).toMatch(/^\[Amended\]/);
    await svc.tick(new Date(run.getTime() + 3 * 3_600_000)); await svc.tick(new Date(run.getTime() + 4 * 3_600_000)); expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(2);       // nothing changed: nothing more is sent
  });
  it("without only-when-closed it goes at once, still labelled provisional while a register is open", async () => {
    await open(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk({ onlyWhenClosed: false }); await backdate(s.id); await svc.tick(at("2030-06-15", "21:30"));
    expect((await runs()).find((r) => r.d === "2030-06-15")).toMatchObject({ status: "provisional" });
  });
  it("a till that still holds unsent sales makes the report provisional; once it has caught up and nothing changed the same version is settled to final without another email", async () => {
    await open(); await sell(1, 2, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk(); await backdate(s.id);
    await h.db.execute(sql`update shelfline.device set queued_count = 3, queued_at = now()`); const t = at("2030-06-15", "21:30");
    await svc.tick(t); const a = (await runs()).filter((r) => r.d === "2030-06-15"); expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ status: "provisional" }); expect(a[0]!.notes.join(" ")).toContain("Not yet fully synced");
    await h.db.execute(sql`update shelfline.device set queued_count = 0`); const n = (await mails()).length; await svc.tick(new Date(t.getTime() + 10 * 60_000));
    expect((await runs()).filter((r) => r.d === "2030-06-15")).toEqual([expect.objectContaining({ version: 1, status: "final" })]); expect((await mails()).length).toBe(n);
  });
  it("the till reports what it still holds when it pushes", async () => {
    await open(); const r = await h.http().post("/sync/push").set("Authorization", `Bearer ${w.tok}`).send({ deviceNow: new Date().toISOString(), queued: 4, commands: [w.cmd("cash.move", { movementId: randomUUID(), sessionId: session, kind: "pay_in", amountMinor: 100, reason: "x" })] });
    expect(r.status).toBe(200); expect((await h.db.execute(sql`select queued_count from shelfline.device where id = ${w.device.id}`)).rows[0]!.queued_count).toBe(4);
  });
});

describe("amending only when a number changed", () => {
  it("a sale that arrives late makes a new, labelled version; a repeat does not", async () => {
    await open(); await sell(0, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk(); await backdate(s.id); const t = at("2030-06-15", "21:30");
    await svc.tick(t); expect((await runs()).filter((r) => r.d === "2030-06-15")).toEqual([expect.objectContaining({ version: 1, status: "final" })]);
    await svc.tick(new Date(t.getTime() + 600_000)); await svc.tick(new Date(t.getTime() + 1_200_000)); expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(1);
    await open(); const late = await sell(1, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString());
    await svc.tick(new Date(t.getTime() + 1_800_000)); const rs = (await runs()).filter((r) => r.d === "2030-06-15"); expect(rs.map((r) => `${r.version}:${r.status}`)).toEqual(["1:final", "2:amended"]);
    const f = (await h.db.execute(sql`select figures->'totals'->>'orders' as o, figures->'totals'->>'grossMinor' as g from shelfline.eod_report_run where version = 2`)).rows[0]!; expect([f.o, Number(f.g)]).toEqual(["2", 21995 + late]);
    await svc.tick(new Date(t.getTime() + 2_400_000)); expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(2);
  });
  it("stops looking after 48 hours", async () => {
    await open(); await sell(0, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk(); await backdate(s.id); const t = at("2030-06-15", "21:30"); await svc.tick(t);
    await open(); await sell(1, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); await svc.tick(new Date(t.getTime() + 49 * 3_600_000));
    expect((await runs()).filter((r) => r.d === "2030-06-15")).toHaveLength(1);
  });
  it("past versions are fixed: figures cannot be changed or deleted, and a version can only settle from provisional to final", async () => {
    await open(); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk(); await backdate(s.id); await svc.tick(at("2030-06-15", "21:30"));
    await expect(h.db.execute(sql`update shelfline.eod_report_run set figures = '{}'::jsonb`)).rejects.toThrow(); await expect(h.db.execute(sql`delete from shelfline.eod_report_run`)).rejects.toThrow(); await expect(h.db.execute(sql`update shelfline.eod_report_run set status = 'amended'`)).rejects.toThrow();
  });
});

describe("how it is delivered", () => {
  it("a PDF attachment is a real PDF with the figures in it; CSV is a spreadsheet; inline has no attachment; each recipient gets one", async () => {
    await open(); await sell(0, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString());
    for (const [format, name, type] of [["pdf", "pdf", "application/pdf"], ["csv", "csv", "text/csv"], ["inline", null, null]] as const) {
      await h.db.execute(sql`truncate table shelfline.eod_report_run, shelfline.scheduled_job, shelfline.email_outbox, shelfline.eod_schedule cascade`); const s = await mk({ format, recipients: ["a@x.test", "b@x.test"] }); await backdate(s.id); await svc.tick(at("2030-06-15", "21:30"));
      const m = (await mails()).filter((x) => /15 June 2030/.test(x.subject)); expect(m.map((x) => x.to_email)).toEqual(["a@x.test", "b@x.test"]); expect(m[0]!.body).toContain("Net sales"); expect(m[0]!.body).toContain("219.95");
      if (!name) { expect(m[0]!.attachment_name).toBeNull(); continue; }
      expect(m[0]).toMatchObject({ attachment_type: type }); expect(m[0]!.attachment_name).toMatch(new RegExp(`\\.${name}$`)); const bytes = Buffer.from(m[0]!.attachment_base64!, "base64").toString("latin1");
      if (name === "pdf") { expect(bytes.startsWith("%PDF-1.4")).toBe(true); expect(bytes).toContain("Net sales"); expect(bytes).toContain("219.95"); } else { expect(bytes.split("\n")[0]).toMatch(/^location,orders/); expect(bytes).toContain("Fitzroy"); }
    }
  });
  it("a webhook receives the figures signed with a secret that is shown once; a failing one is recorded, not hidden", async () => {
    const got: { body: string; sig: string; ts: string }[] = []; let fail = false;
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ body: b, sig: String(req.headers["x-shelfline-signature"]), ts: String(req.headers["x-shelfline-timestamp"]) }); res.statusCode = fail ? 500 : 200; res.end("ok"); }); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`;
    try {
      await open(); await sell(0, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString());
      const s = await mk({ methods: ["webhook"], recipients: [], webhookUrl: url }); expect(s.webhookSecret).toMatch(/^[0-9a-f]{48}$/); await backdate(s.id);
      expect((await w.owner.get("/eod-schedules")).body[0]).toMatchObject({ hasWebhookSecret: true }); expect(JSON.stringify((await w.owner.get("/eod-schedules")).body)).not.toContain(s.webhookSecret!);
      await svc.tick(at("2030-06-15", "21:30")); const hit = got.find((g) => JSON.parse(g.body).localDate === "2030-06-15")!; expect(hit.sig).toBe(createHmac("sha256", s.webhookSecret!).update(`${hit.ts}.${hit.body}`).digest("hex")); expect(JSON.parse(hit.body)).toMatchObject({ schedule: "Fitzroy close", status: "final", version: 1, figures: { totals: { orders: 1 } } });
      expect((await runs()).find((r) => r.d === "2030-06-15")!.delivered[0]).toMatchObject({ ok: true, method: "webhook" });
      fail = true; await w.owner.post(`/eod-schedules/${s.id}/send-now`, { date: "2030-06-15" }); expect((await runs()).find((r) => r.version === 2)!.delivered[0]).toMatchObject({ ok: false, detail: "HTTP 500" });
    } finally { srv.close(); }
  });
});

describe("setting it up", () => {
  it("only HQ managers, finance and owners; bad schedules are refused", async () => {
    expect((await w.mgr.get("/eod-schedules")).status).toBe(403); expect((await w.mgr.post("/eod-schedules", { name: "x", sendAtLocal: "21:30", timezone: MEL, methods: ["email"], recipients: ["a@x.test"] })).status).toBe(403);
    const base = { name: "x", locationIds: null, sendAtLocal: "21:30", timezone: MEL, methods: ["email"], recipients: ["a@x.test"] };
    for (const bad of [{ timezone: "Mars/Olympus" }, { recipients: [] }, { sendAtLocal: "25:00" }, { methods: ["webhook"], webhookUrl: null }, { methods: ["webhook"], webhookUrl: "ftp://x.test/hook" }, { methods: ["webhook"], webhookUrl: "not a url" }, { daysOfWeek: [] }, { daysOfWeek: [7] }, { methods: [] }, { format: "docx" }, { locationIds: [] }, { recipients: ["nope"] }])
      expect([JSON.stringify(bad), (await w.owner.post("/eod-schedules", { ...base, ...bad })).status >= 400]).toEqual([JSON.stringify(bad), true]);
    expect((await w.owner.post("/eod-schedules", { ...base, locationIds: [randomUUID()] })).status).toBe(404); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.eod_schedule`)).rows[0]!.n).toBe(0);
    await w.owner.post("/users", { email: "fin@kestrel.test", name: "Fin", password: "finance-password-12", assignments: [{ role: "finance", locationId: null }] }); const fin = w.as((await w.login("fin@kestrel.test", "finance-password-12")).body.token);
    expect((await fin.post("/eod-schedules", { ...base })).status).toBe(201);
  });
  it("can be paused and edited; a paused schedule is never sent; 'send now' makes a new version on request and is audited", async () => {
    await open(); await sell(0, 1, "2030-06-15"); await close(); await dateSessions(at("2030-06-15", "09:00").toISOString()); const s = await mk(); await backdate(s.id);
    expect((await w.owner.patch(`/eod-schedules/${s.id}`, { active: false })).status).toBe(200); await svc.tick(at("2030-06-15", "21:30")); expect(await jobs()).toHaveLength(0);
    expect((await w.owner.patch(`/eod-schedules/${s.id}`, { sendAtLocal: "20:00", recipients: [] })).status).toBe(400);            // email with nobody to send to
    const a = await w.owner.post(`/eod-schedules/${s.id}/send-now`, { date: "2030-06-15" }); expect(a.status).toBe(200); expect(a.body).toMatchObject({ version: 1 });
    const b = await w.owner.post(`/eod-schedules/${s.id}/send-now`, { date: "2030-06-15" }); expect(b.body.version).toBe(2); expect((await w.owner.get("/audit?action=eod_schedule.send_now")).body).toHaveLength(2);
    const list = (await w.owner.get(`/eod-runs?scheduleId=${s.id}`)).body; expect(list).toHaveLength(2); const text = (await w.owner.get(`/eod-runs/${list[0].id}`)).body; expect(text.lines.join("\n")).toContain("Net sales"); expect(text.csv).toMatch(/^location,orders/);
    expect((await w.owner.get("/eod-schedules")).body[0].last).toMatchObject({ date: "2030-06-15", version: 2 });
  });
});
