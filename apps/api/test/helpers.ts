import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { loadConfig } from "../src/config";
import * as schema from "../src/db/schema";
import { seedOrg } from "../src/seed";

export const OWNER = { email: "elena@kestrel.test", password: "owner-password-123" };

export async function startApp() {
  const config = loadConfig();
  const app: INestApplication = await NestFactory.create(AppModule.register(config), { logger: false });
  configureApp(app);
  await app.init();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  const db = drizzle(pool, { schema });
  const http = () => request(app.getHttpServer());
  return { app, db, pool, http, config, close: async () => { await app.close(); await pool.end(); } };
}
export type Harness = Awaited<ReturnType<typeof startApp>>;

export async function reset(h: Harness) {
  await h.db.execute(sql`truncate table shelfline.change_log, shelfline.sync_exception, shelfline.audit_log, shelfline.user_assignment, shelfline.role_permission, shelfline.role, shelfline.device, shelfline.register, shelfline.staff_profile, shelfline."user", shelfline.location, shelfline.org restart identity cascade`);
}

/** Org + owner + two stores (Fitzroy, South Yarra) + a store manager at Fitzroy + a cashier with PIN and a POS device at Fitzroy. */
export async function world(h: Harness) {
  const { orgId } = await seedOrg(h.db, { orgName: "Kestrel Run Co.", currency: "AUD", timezone: "Australia/Melbourne", ownerEmail: OWNER.email, ownerPassword: OWNER.password });
  const login = async (email: string, password: string, totp?: string) => h.http().post("/auth/login").send({ email, password, totp });
  const ownerTok = (await login(OWNER.email, OWNER.password)).body.token as string;
  const as = (tok: string) => ({
    get: (u: string) => h.http().get(u).set("Authorization", `Bearer ${tok}`),
    post: (u: string, b?: object) => h.http().post(u).set("Authorization", `Bearer ${tok}`).send(b ?? {}),
    put: (u: string, b?: object) => h.http().put(u).set("Authorization", `Bearer ${tok}`).send(b ?? {}),
    patch: (u: string, b?: object) => h.http().patch(u).set("Authorization", `Bearer ${tok}`).send(b ?? {}),
    delete: (u: string) => h.http().delete(u).set("Authorization", `Bearer ${tok}`),
  });
  const owner = as(ownerTok);
  const fitzroy = (await owner.post("/locations", { code: "fit", name: "Fitzroy", type: "store", timezone: "Australia/Melbourne" })).body;
  const southYarra = (await owner.post("/locations", { code: "sya", name: "South Yarra", type: "store", timezone: "Australia/Melbourne" })).body;
  const mgrPw = "manager-password-123";
  const manager = (await owner.post("/users", { email: "marcus@kestrel.test", name: "Marcus T.", password: mgrPw, assignments: [{ role: "store_manager", locationId: fitzroy.id }] })).body;
  const cashier = (await owner.post("/users", { email: "priya@kestrel.test", name: "Priya N.", employeeCode: "117", pin: "4821", assignments: [{ role: "cashier", locationId: fitzroy.id }] })).body;
  const reg = (await owner.post(`/locations/${fitzroy.id}/registers`, { code: "fit-2", name: "Front desk" })).body;
  const dev = (await owner.post("/devices", { kind: "pos", locationId: fitzroy.id, registerId: reg.id, name: "iPad FIT-2" })).body;
  const mgrTok = (await login("marcus@kestrel.test", mgrPw)).body.token as string;
  return { orgId, login, owner, as, ownerTok, fitzroy, southYarra, manager, cashier, register: reg, device: dev, mgr: as(mgrTok), mgrTok };
}

export async function catalogWorld(h: Harness) {
  const w = await world(h);
  const gst = (await w.owner.post("/tax-classes", { key: "gst", name: "GST" })).body;
  const free = (await w.owner.post("/tax-classes", { key: "gst_free", name: "GST-free" })).body;
  await w.owner.post(`/tax-classes/${gst.id}/rates`, { rateBp: 1000, inclusive: true, validFrom: "2000-07-01" });
  await w.owner.post(`/tax-classes/${free.id}/rates`, { rateBp: 0, inclusive: true, validFrom: "2000-07-01" });
  const shoes = (await w.owner.post("/categories", { name: "Running shoes" })).body;
  const hq = (await w.owner.post("/users", { email: "dana@kestrel.test", name: "Dana", password: "hq-password-12345", assignments: [{ role: "hq_manager", locationId: null }] })).body;
  const hqTok = (await w.login("dana@kestrel.test", "hq-password-12345")).body.token as string;
  const glide = { title: "Tempra Glide 3", brand: "Tempra", categoryId: shoes.id, taxClassId: gst.id, variants: [
    { sku: "TG3-M-10-BW", barcode: "9300000100101", options: { size: "10", colour: "Black/White" }, basePriceMinor: 21995 },
    { sku: "TG3-M-105-BW", barcode: "9300000100105", options: { size: "10.5", colour: "Black/White" }, basePriceMinor: 21995 },
  ] };
  return { ...w, gst, free, shoes, hq, hqTok, hqApi: w.as(hqTok), glide };
}

/** Catalogue + stock + a POS token for the Fitzroy device + helpers to build device commands. */
export async function posWorld(h: Harness, opts: { stock?: number } = {}) {
  const { randomUUID } = await import("node:crypto");
  const { uuidv7 } = await import("@shelfline/sync-client");
  const { SCHEMA_V } = await import("@shelfline/contracts");
  const c = await catalogWorld(h);
  const p = (await c.hqApi.post("/products", { title: "Tempra Glide 3", taxClassId: c.gst.id, variants: [
    { sku: "TG3-A", barcode: "9300000300001", basePriceMinor: 21995 }, { sku: "TG3-B", barcode: "9300000300002", basePriceMinor: 8900 }, { sku: "TG3-C", barcode: "9300000300003", basePriceMinor: 3400 }] })).body;
  const v = p.variants as { id: string; basePriceMinor: number }[];
  for (const x of v) await c.hqApi.post("/inventory/receive", { locationId: c.fitzroy.id, idempotencyKey: randomUUID(), lines: [{ variantId: x.id, qty: opts.stock ?? 10, unitCostMinor: 5000 }] });
  const tok = (await h.http().post("/pos/pin").set("x-device-key", c.device.key).send({ employeeCode: "117", pin: "4821" })).body.token as string;
  let seq = 0;
  const cmd = (type: string, payload: unknown, o: { actorId?: string; id?: string; seq?: number } = {}) =>
    ({ id: o.id ?? uuidv7(), seq: o.seq ?? ++seq, type, payload, clientTs: new Date().toISOString(), schemaV: SCHEMA_V, actorId: o.actorId ?? c.cashier.id });
  const push = (commands: object[], t = tok) => h.http().post("/sync/push").set("Authorization", `Bearer ${t}`).send({ deviceNow: new Date().toISOString(), commands });
  return { ...c, p, v, tok, cmd, push, randomUUID, resetSeq: () => { seq = 0; } };
}
