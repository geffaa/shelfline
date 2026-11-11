import { expect, type Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { SCHEMA_V } from "@shelfline/contracts";
import { uuidv7 } from "@shelfline/sync-client";

export const API = "http://localhost:8201";
export const OWNER = { email: "owner@e2e.test", password: "e2e-owner-password-123" };
const DB = "postgres://shelfline:shelfline@localhost:54340/shelfline_e2e";
export async function http<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as T };
}
export const sql = async <T = any>(q: string, p: unknown[] = []): Promise<T[]> => { const c = new pg.Client({ connectionString: DB }); await c.connect(); try { return (await c.query(q, p)).rows as T[]; } finally { await c.end(); } };
const rnd = () => Math.random().toString(36).slice(2, 7).toUpperCase();
export const ownerToken = async () => (await http("POST", "/auth/login", null, OWNER)).body.token as string;

export interface Store { tag: string; name: string; id: string; code: string; regId: string; regCode: string; devKey: string; devId: string; token: string; seq: number; sessionId?: string; variants: { id: string; sku: string; barcode: string; price: number }[] }
export interface World { owner: string; stores: Store[]; taxId: string; cashier: { code: string; pin: string; id: string }; manager: { email: string; password: string; id: string } }

/** Two stores with a register and a POS device each, a cashier, a store manager for the first store, and 3 stocked products. Everything through the public API. */
export async function provisionWorld(opts: { stores?: number; stock?: number } = {}): Promise<World> {
  const owner = await ownerToken(); const tag = rnd();
  const gst = (await http("GET", "/tax-classes", owner)).body.find((c: any) => c.key === "gst") ?? (await http("POST", "/tax-classes", owner, { key: "gst", name: "GST" })).body;
  if (!gst.rates?.length) await http("POST", `/tax-classes/${gst.id}/rates`, owner, { rateBp: 1000, inclusive: true, validFrom: "2000-07-01" });
  const stores: Store[] = [];
  for (let i = 0; i < (opts.stores ?? 2); i++) {
    const name = `${["Fitzroy", "South Yarra", "Fremantle"][i]} ${tag}`; const code = `S${tag}${i}`;
    const loc = (await http("POST", "/locations", owner, { code, name, type: "store", timezone: i === 2 ? "Australia/Perth" : "Australia/Melbourne" })).body;
    const reg = (await http("POST", `/locations/${loc.id}/registers`, owner, { code: `R${tag}${i}`, name: "Front desk" })).body;
    const dev = (await http("POST", "/devices", owner, { kind: "pos", locationId: loc.id, registerId: reg.id, name: `iPad ${tag}${i}` })).body;
    stores.push({ tag, name, id: loc.id, code, regId: reg.id, regCode: reg.code, devKey: dev.key, devId: dev.id, token: "", seq: 0, variants: [] });
  }
  const cashier = { code: `C${tag}`, pin: "4821", id: "" }; const manager = { email: `marcus.${tag.toLowerCase()}@e2e.test`, password: "manager-password-123", id: "" };
  cashier.id = (await http("POST", "/users", owner, { email: `priya.${tag}@e2e.test`, name: `Priya ${tag}`, employeeCode: cashier.code, pin: cashier.pin, assignments: stores.map((s) => ({ role: "cashier", locationId: s.id })) })).body.id;
  manager.id = (await http("POST", "/users", owner, { email: manager.email, name: `Marcus ${tag}`, password: manager.password, assignments: [{ role: "store_manager", locationId: stores[0]!.id }] })).body.id;
  const defs = [{ title: "Tempra Glide 3", price: 21995, opt: { size: "10.5", colour: "Black/White" } }, { title: "Merino tee", price: 8900, opt: { size: "M", colour: "Slate" } }, { title: "Crew socks 2-pack", price: 3400, opt: { size: "L" } }];
  const variants: Store["variants"] = [];
  for (const [i, d] of defs.entries()) {
    const barcode = `93${tag.replace(/\D/g, "").padEnd(2, "7")}${i}${String(Date.now()).slice(-7)}`.slice(0, 13).padEnd(13, "0"); const sku = `${["TG3", "MT", "CS"][i]}-${tag}`;
    const p = (await http("POST", "/products", owner, { title: `${d.title} ${tag}`, taxClassId: gst.id, variants: [{ sku, barcode, options: d.opt, basePriceMinor: d.price }] })).body; expect(p.variants?.[0]?.id, JSON.stringify(p)).toBeTruthy();
    for (const s of stores) await http("POST", "/inventory/receive", owner, { locationId: s.id, idempotencyKey: randomUUID(), lines: [{ variantId: p.variants[0].id, qty: opts.stock ?? 20, unitCostMinor: 5000 }] });
    variants.push({ id: p.variants[0].id, sku, barcode, price: d.price });
  }
  for (const s of stores) { s.variants = variants; s.token = (await http("POST", "/pos/pin", null, { employeeCode: cashier.code, pin: cashier.pin }, { "x-device-key": s.devKey })).body.token; }
  return { owner, stores, taxId: gst.id, cashier, manager };
}

export const cmd = (s: Store, w: World, type: string, payload: unknown) => ({ id: uuidv7(), seq: ++s.seq, type, payload, clientTs: new Date().toISOString(), schemaV: SCHEMA_V, actorId: w.cashier.id });
export const push = (s: Store, commands: object[]) => http("POST", "/sync/push", s.token, { deviceNow: new Date().toISOString(), commands });
export async function openSession(s: Store, w: World, float = 30000) { const id = randomUUID(); const r = await push(s, [cmd(s, w, "session.open", { sessionId: id, openingFloatMinor: float })]); expect(r.body.results[0].status).toBe("accepted"); s.sessionId = id; return id; }
export function saleCmd(s: Store, w: World, lines: { v: number; qty: number; price?: number; discount?: number }[], tender: "cash" | "card" = "cash", o: { tamper?: number; receiptNo?: string } = {}) {
  const ls = lines.map((l) => ({ variantId: s.variants[l.v]!.id, qty: l.qty, unitPriceMinor: l.price ?? s.variants[l.v]!.price, discountMinor: l.discount ?? 0 }));
  const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } })));
  return cmd(s, w, "sale.create", { saleId: randomUUID(), sessionId: s.sessionId, receiptNo: o.receiptNo ?? `${s.regCode}-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, customerId: null, lines: ls, payments: [{ tender, amountMinor: p.payableMinor + (o.tamper ?? 0), ...(tender === "cash" ? { tenderedMinor: p.payableMinor + (o.tamper ?? 0) } : {}) }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: p.discountMinor, taxMinor: p.taxMinor, totalMinor: p.totalMinor + (o.tamper ?? 0), roundingMinor: 0, payableMinor: p.payableMinor + (o.tamper ?? 0) }, cashRoundingStep: null });
}
export const sell = (s: Store, w: World, lines: Parameters<typeof saleCmd>[2], tender: "cash" | "card" = "cash", o: Parameters<typeof saleCmd>[4] = {}) => push(s, [saleCmd(s, w, lines, tender, o)]);
export const closeSession = (s: Store, w: World, counted: number) => push(s, [cmd(s, w, "session.close", { sessionId: s.sessionId, countedMinor: counted })]);
export const cashMove = (s: Store, w: World, kind: string, amountMinor: number, reason?: string) => push(s, [cmd(s, w, "cash.move", { movementId: randomUUID(), sessionId: s.sessionId, kind, amountMinor, ...(reason ? { reason } : {}) })]);

export async function signIn(page: Page, email = OWNER.email, password = OWNER.password) {
  await page.goto("/"); await page.getByLabel("Email").fill(email); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Domains" }).first()).toBeVisible({ timeout: 20_000 });
}
export const lens = (page: Page, name: RegExp | string) => page.getByRole("complementary", { name: "Locations" }).getByRole("button", { name });
