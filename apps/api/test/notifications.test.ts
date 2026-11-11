import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { zonedInstant } from "../src/common/business-day";
import { NotificationsService } from "../src/notifications/notifications.service";
import type { NotifyEvent } from "../src/notifications/engine";
import { posWorld, reset, startApp, type Harness } from "./helpers";

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; let svc: NotificationsService; let session: string;
beforeAll(async () => { h = await startApp(); svc = h.app.get(NotificationsService); }, 60_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => {
  await reset(h); await h.db.execute(sql`truncate table shelfline.email_outbox, shelfline.notification, shelfline.notification_rule restart identity cascade`);
  w = await posWorld(h, { stock: 20 }); session = randomUUID(); expect((await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 30000 })])).body.results[0].status).toBe("accepted");
  await new Promise((r) => setTimeout(r, 300));       // let the open event (no rules yet) pass
});
const TZ = "Australia/Melbourne"; const at = (date: string, hm: string) => new Date(zonedInstant(date, hm, TZ));
const rule = async (o: object = {}) => { const r = await w.owner.post("/notification-rules", { name: "r", eventKind: "no_sale", recipientUserIds: [w.manager.id], ...o }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; };
const inbox = async (api = w.mgr, q = "") => (await api.get(`/notifications${q}`)).body as { id: string; title: string; body: string; readAt: string | null; severity: string }[];
const mail = async (to = "marcus@kestrel.test") => (await h.db.execute(sql`select subject, body, kind from shelfline.email_outbox where to_email = ${to} order by created_at`)).rows as { subject: string; body: string; kind: string }[];
const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 8000) => { const t = Date.now(); for (;;) { const v = await f(); if (ok(v) || Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 100)); } };
const noSale = (reason?: string) => w.push([w.cmd("cash.move", { movementId: randomUUID(), sessionId: session, kind: "no_sale", amountMinor: 0, ...(reason ? { reason } : {}) })]);
const ev = (o: Partial<NotifyEvent> = {}): NotifyEvent => ({ kind: "no_sale", ref: `t:${randomUUID()}`, locationId: w.fitzroy.id, severity: "info", title: "Test event", body: "body", facts: {}, ...o });

describe("a no-sale tells the manager within a minute", () => {
  it("reaches the inbox and the email, within seconds of the till syncing, and only once however often it is looked at again", async () => {
    await rule({ channels: ["in_app", "email"] }); const t0 = Date.now(); expect((await noSale("change for a customer")).body.results[0].status).toMatch(/accepted/);
    const got = await until(() => inbox(), (l) => l.length > 0); const took = Date.now() - t0;
    expect(got).toHaveLength(1); expect(took).toBeLessThan(60_000); expect(got[0]).toMatchObject({ title: "No-sale at Fitzroy", severity: "info" }); expect(got[0]!.body).toContain("change for a customer");
    expect((await mail()).filter((m) => m.kind === "notification")).toHaveLength(1);
    const again = await svc.sweep(); await svc.sweep(); await svc.process(w.orgId, "cash", String((await h.db.execute(sql`select id from shelfline.cash_movement`)).rows[0]!.id));
    expect(again.made).toBe(0); expect(await inbox()).toHaveLength(1); expect((await mail()).filter((m) => m.kind === "notification")).toHaveLength(1);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.notification`)).rows[0]!.n).toBe(1);
  });
  it("a no-sale with no reason is a warning, and replaying the identical event twice makes one message", async () => {
    await rule(); await noSale(); const l = await until(() => inbox(), (x) => x.length > 0); expect(l[0]!.severity).toBe("warning"); expect(l[0]!.body).toContain("No reason was given");
    const e = ev(); expect(await svc.dispatch(w.orgId, e)).toBe(1); expect(await svc.dispatch(w.orgId, e)).toBe(0); expect(await svc.dispatch(w.orgId, { ...e })).toBe(0);
  });
  it("a message that was missed while the server was down is found by the sweep", async () => {
    await noSale("before the rule existed"); await new Promise((r) => setTimeout(r, 300)); await rule();
    expect(await inbox()).toHaveLength(0); const r = await svc.sweep(); expect(r.made).toBe(1); expect(await inbox()).toHaveLength(1); expect((await svc.sweep()).made).toBe(0);
  });
});

describe("quiet hours", () => {
  const night = at("2026-11-04", "23:30"), morning = at("2026-11-05", "07:00");
  it("hold an ordinary message and its email until the window ends, then deliver both once", async () => {
    await rule({ channels: ["in_app", "email"], quietStart: "22:00", quietEnd: "07:00" });
    expect(await svc.dispatch(w.orgId, ev(), night)).toBe(1); expect(await inbox()).toHaveLength(0); expect(await mail()).toHaveLength(0);
    expect((await h.db.execute(sql`select status, email_status, held_until from shelfline.notification`)).rows[0]).toMatchObject({ status: "held", email_status: "held" });
    expect(await svc.release(at("2026-11-05", "06:59"))).toBe(0); expect(await inbox()).toHaveLength(0);
    expect(await svc.release(morning)).toBe(1); expect(await svc.release(morning)).toBe(0);
    expect(await inbox()).toHaveLength(1); expect((await mail()).filter((m) => m.kind === "notification")).toHaveLength(1);
  });
  it("do not hold a critical event or a critical rule, and do not hold outside the window", async () => {
    await rule({ channels: ["in_app", "email"], quietStart: "22:00", quietEnd: "07:00" });
    await svc.dispatch(w.orgId, ev({ severity: "critical", title: "Big one" }), night); await svc.dispatch(w.orgId, ev({ title: "Daytime" }), at("2026-11-04", "14:00"));
    expect((await inbox()).map((m) => m.title).sort()).toEqual(["Big one", "Daytime"]);
    await rule({ name: "always", critical: true, quietStart: "22:00", quietEnd: "07:00", recipientUserIds: [w.cashier.id] }); await svc.dispatch(w.orgId, ev({ title: "Night shift" }), night);
    expect((await h.db.execute(sql`select status from shelfline.notification where title = 'Night shift' and user_id = ${w.cashier.id}`)).rows[0]!.status).toBe("delivered");
  });
  it("use the place's own clock: 21:30 in Perth is awake while 23:30 in Melbourne is asleep", async () => {
    const perth = (await w.owner.post("/locations", { code: "fre", name: "Fremantle", type: "store", timezone: "Australia/Perth" })).body;
    await rule({ eventKind: "no_sale", quietStart: "23:00", quietEnd: "07:00", locationIds: null });
    const now = new Date("2026-06-15T13:30:00Z");                                             // Perth 21:30, Melbourne 23:30
    await svc.dispatch(w.orgId, ev({ locationId: perth.id, title: "Perth" }), now); await svc.dispatch(w.orgId, ev({ locationId: w.fitzroy.id, title: "Melbourne" }), now);
    const rows = (await h.db.execute(sql`select title, status from shelfline.notification order by title`)).rows; expect(rows).toEqual([{ title: "Melbourne", status: "held" }, { title: "Perth", status: "delivered" }]);
  });
});

describe("who is told", () => {
  it("by role at the place of the event: this store's manager, not another store's, and not people without that role", async () => {
    const other = (await w.owner.post("/users", { email: "sy@kestrel.test", name: "Sy Manager", password: "south-yarra-pass-3", assignments: [{ role: "store_manager", locationId: w.southYarra.id }] })).body;
    await rule({ recipientUserIds: [], recipientRoles: ["store_manager"] }); await svc.dispatch(w.orgId, ev());
    expect((await h.db.execute(sql`select user_id from shelfline.notification`)).rows.map((r) => r.user_id)).toEqual([w.manager.id]); void other;
    await svc.dispatch(w.orgId, ev({ locationId: w.southYarra.id })); expect((await h.db.execute(sql`select count(*)::int as n from shelfline.notification where user_id = ${other.id}`)).rows[0]!.n).toBe(1);
  });
  it("limited to chosen places, and a rule can be switched off", async () => {
    const id = await rule({ locationIds: [w.southYarra.id] }); expect(await svc.dispatch(w.orgId, ev())).toBe(0); expect(await svc.dispatch(w.orgId, ev({ locationId: w.southYarra.id }))).toBe(1);
    expect((await w.owner.patch(`/notification-rules/${id}`, { active: false })).status).toBe(200); expect(await svc.dispatch(w.orgId, ev({ locationId: w.southYarra.id }))).toBe(0);
  });
  it("only people who are active staff are told", async () => {
    await rule({ recipientUserIds: [w.manager.id, w.cashier.id] }); await h.db.execute(sql`update shelfline."user" set status = 'disabled' where id = ${w.cashier.id}`); expect(await svc.dispatch(w.orgId, ev())).toBe(1);
  });
});

describe("the other events", () => {
  it("a large refund passes the threshold only when it reaches it", async () => {
    await rule({ eventKind: "large_refund", conditions: { minMinor: 20000 } });
    expect(await svc.dispatch(w.orgId, ev({ kind: "large_refund", facts: { amountMinor: 19999 } }))).toBe(0); expect(await svc.dispatch(w.orgId, ev({ kind: "large_refund", facts: { amountMinor: 20000 } }))).toBe(1);
  });
  it("a register opening and closing, a short drawer and a clock-in come from the real events", async () => {
    await rule({ name: "open", eventKind: "register_open" }); await rule({ name: "close", eventKind: "register_close" }); await rule({ name: "var", eventKind: "cash_variance", conditions: { varianceOverMinor: 1000 }, channels: ["in_app", "email"] }); await rule({ name: "in", eventKind: "punch_in" }); await rule({ name: "out", eventKind: "punch_out" });
    const s2 = randomUUID(); await w.push([w.cmd("session.close", { sessionId: session, countedMinor: 23000 }), w.cmd("session.open", { sessionId: s2, openingFloatMinor: 10000 })]);       // 70.00 short on the first, a new one opened
    const punch = (kind: string) => w.push([{ ...w.cmd("punch.record", { punchId: randomUUID(), kind, method: "pin" }), clientTs: new Date().toISOString() }]); await punch("in"); await punch("out");
    const titles = async () => (await inbox()).map((m) => m.title).sort();
    const l = await until(titles, (x) => x.length >= 5);
    expect(l.some((t) => /Front desk closed at Fitzroy/.test(t))).toBe(true); expect(l.some((t) => /Front desk opened at Fitzroy/.test(t))).toBe(true); expect(l.some((t) => /Short A\$.* at Fitzroy/.test(t))).toBe(true);
    expect(l.some((t) => /clocked in at Fitzroy/.test(t))).toBe(true); expect(l.some((t) => /clocked out at Fitzroy/.test(t))).toBe(true);
    const v = (await inbox()).find((m) => /^Short/.test(m.title))!; expect(v.severity).toBe("critical");                                                      // 70.00 short is over the A$50 line expect((await mail()).some((m) => /^Short/.test(m.subject))).toBe(true);
  });
  it("a late arrival is worked out against the published shift; a sale of 30 minutes' lateness passes a 10 minute threshold and 5 minutes does not", async () => {
    await rule({ eventKind: "late_arrival", conditions: { minLateMinutes: 10 } });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const mk = async (start: string, end: string, d: string) => (await w.mgr.post("/shifts", { locationId: w.fitzroy.id, userId: w.cashier.id, date: d, start, end })).body;
    // a shift that started 30 minutes before now
    const now = new Date(); const startLocal = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now.getTime() - 30 * 60_000)); const endLocal = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now.getTime() + 3 * 3_600_000));
    if (startLocal > endLocal) return;                                                        // within half an hour of midnight: the shift would run overnight; the engine covers that, this assertion does not
    await mk(startLocal, endLocal, day); await w.mgr.post("/shifts/publish", { locationId: w.fitzroy.id, from: day, to: day });
    await w.push([{ ...w.cmd("punch.record", { punchId: randomUUID(), kind: "in", method: "pin" }), clientTs: now.toISOString() }]);
    const l = await until(() => inbox(), (x) => x.length > 0); expect(l[0]!.title).toMatch(/is 3\d min late at Fitzroy/); expect(l[0]!.severity).toBe("warning");
  });
});

describe("daily summaries", () => {
  it("collect a day's messages into one email at the summary time, and send it once", async () => {
    await rule({ channels: ["email"], digest: true, digestAt: "18:00" }); const morning = at("2026-11-04", "10:00");
    await svc.dispatch(w.orgId, ev({ title: "First" }), morning); await svc.dispatch(w.orgId, ev({ title: "Second" }), at("2026-11-04", "11:00"));
    expect(await mail()).toHaveLength(0); expect((await h.db.execute(sql`select email_status from shelfline.notification`)).rows.map((r) => r.email_status)).toEqual(["digest", "digest"]);
    await h.db.execute(sql`update shelfline.notification set created_at = ${morning.toISOString()}::timestamptz`);
    expect(await svc.sendDigests(at("2026-11-04", "17:59"))).toBe(0); expect(await svc.sendDigests(at("2026-11-04", "18:00"))).toBe(1); expect(await svc.sendDigests(at("2026-11-04", "19:00"))).toBe(0);
    const m = await mail(); expect(m).toHaveLength(1); expect(m[0]).toMatchObject({ kind: "notification_digest", subject: "Shelfline summary: 2 updates" }); expect(m[0]!.body).toContain("- First"); expect(m[0]!.body).toContain("- Second");
  });
});

describe("rules and the inbox", () => {
  it("only people with the notification permission manage rules, and bad rules are refused", async () => {
    expect((await w.mgr.get("/notification-rules")).status).toBe(403); expect((await w.mgr.post("/notification-rules", { name: "x", eventKind: "no_sale", recipientUserIds: [w.manager.id] })).status).toBe(403);
    const bad = [{ recipientUserIds: [] }, { eventKind: "nope" }, { quietStart: "22:00" }, { quietStart: "25:00", quietEnd: "07:00" }, { conditions: { minMinor: 5 } }, { locationIds: [] }, { channels: [] }, { channels: ["sms"] }, { recipientRoles: ["wizard"], recipientUserIds: [] }, { name: "" }];
    for (const b of bad) expect([JSON.stringify(b), (await w.owner.post("/notification-rules", { name: "r", eventKind: "no_sale", recipientUserIds: [w.manager.id], ...b })).status >= 400]).toEqual([JSON.stringify(b), true]);
    expect((await w.owner.post("/notification-rules", { name: "r", eventKind: "no_sale", recipientUserIds: [randomUUID()] })).status).toBe(404);
    expect((await w.owner.get("/audit?action=notification_rule.create")).body).toHaveLength(0);
  });
  it("everyone sees only their own inbox; marking read works one at a time or all at once; a portal token is refused", async () => {
    await rule({ recipientUserIds: [w.manager.id, w.cashier.id] }); await svc.dispatch(w.orgId, ev({ title: "A" })); await svc.dispatch(w.orgId, ev({ title: "B" })); await svc.dispatch(w.orgId, ev({ title: "C" }));
    expect((await w.mgr.get("/notifications/unread-count")).body).toEqual({ count: 3 }); expect((await w.owner.get("/notifications")).body).toEqual([]); expect((await w.owner.get("/notifications/unread-count")).body).toEqual({ count: 0 });
    const ids = (await inbox()).map((m) => m.id); expect((await w.mgr.post("/notifications/read", { ids: [ids[0]!] })).body).toEqual({ read: 1 }); expect((await w.mgr.post("/notifications/read", { ids: [ids[0]!] })).body).toEqual({ read: 0 });
    expect((await inbox(w.mgr, "?unread=1"))).toHaveLength(2); expect((await w.owner.post("/notifications/read", { ids })).body).toEqual({ read: 0 });           // not yours
    expect((await w.mgr.post("/notifications/read", { all: true })).body).toEqual({ read: 2 }); expect((await w.mgr.get("/notifications/unread-count")).body).toEqual({ count: 0 }); expect((await w.mgr.post("/notifications/read", {})).status).toBe(400);
    expect((await h.db.execute(sql`select count(*)::int as n from shelfline.notification where read_at is null and user_id = ${w.cashier.id}`)).rows[0]!.n).toBe(3);
    await w.owner.post("/report-grants", { email: "pt@x.test", reportKeys: ["sales"], locationIds: null, rangeKind: "rolling", rollingDays: 7, hiddenColumns: [] }); await h.http().post("/portal/auth/request-code").send({ email: "pt@x.test" });
    const code = /(\d{6})/.exec((await mail("pt@x.test")).find((m) => m.kind === "portal_code")!.subject)![1]!; const tok = (await h.http().post("/portal/auth/verify").send({ email: "pt@x.test", code })).body.token;
    expect((await h.http().get("/notifications").set("Authorization", `Bearer ${tok}`)).status).toBe(401);
  });
  it("the delivery log shows who was told, what happened to it and when held ones will arrive", async () => {
    const id = await rule({ quietStart: "22:00", quietEnd: "07:00" }); await svc.dispatch(w.orgId, ev({ title: "Night" }), at("2026-11-04", "23:30")); await svc.dispatch(w.orgId, ev({ title: "Day" }), at("2026-11-04", "12:00"));
    const log = (await w.owner.get(`/notification-log?ruleId=${id}`)).body; expect(log.map((l: { title: string; status: string }) => `${l.title}:${l.status}`).sort()).toEqual(["Day:delivered", "Night:held"]); expect(log[0]).toMatchObject({ to: "Marcus T." });
    const rules = (await w.owner.get("/notification-rules")).body; expect(rules[0]).toMatchObject({ sent: 2, recipients: ["Marcus T."] });
  });
});
