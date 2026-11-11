/**
 * Demo data: "Kestrel Run Co." (synthetic). 4 stores + 1 distribution centre, ~900 variants, ~300 customers and 90 days of till traffic.
 * Everything goes through the public API and the real sync endpoint, so the numbers you see are the numbers the system computes.
 *
 *   pnpm --filter @shelfline/api demo:seed            # needs a migrated, empty database
 *   pnpm --filter @shelfline/api demo:seed -- --reset # drops and recreates the schema first
 *   DEMO_DAYS=14 pnpm ... demo:seed                   # a shorter history
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import { SCHEMA_V } from "@shelfline/contracts";
import { priceCart, refundAmount } from "@shelfline/pricing";
import { uuidv7 } from "@shelfline/sync-client";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { loadConfig } from "./config";
import { runMigrations } from "./db/migrate";
import * as schema from "./db/schema";
import { seedOrg } from "./seed";
import { LedgerService } from "./inventory/ledger.service";

export const DEMO = { owner: { email: "elena@kestrel.test", password: "kestrel-demo-2026" }, hq: { email: "dana@kestrel.test", password: "kestrel-demo-2026" }, manager: { email: "marcus@kestrel.test", password: "kestrel-demo-2026" }, pin: "4821" };
const DAYS = Number(process.env.DEMO_DAYS ?? 90);
const rngFrom = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const R = rngFrom(20260901); const pick = <T,>(a: readonly T[]) => a[Math.floor(R() * a.length)]!; const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const ean13 = (body12: string) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(body12[i]) * (i % 2 ? 3 : 1); return body12 + ((10 - (s % 10)) % 10); };

/** UTC instant of a wall-clock time in an IANA zone (no date library: ask Intl what the zone's offset is at that instant). */
function zoned(date: string, hm: string, tz: string): number {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const off = (t: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t; };
  return guess - off(guess - off(guess));
}

const STORES = [
  { code: "fit", name: "Fitzroy", tz: "Australia/Melbourne", regs: 2, weight: 1.0 },
  { code: "sya", name: "South Yarra", tz: "Australia/Melbourne", regs: 2, weight: 1.25 },
  { code: "fre", name: "Fremantle", tz: "Australia/Perth", regs: 1, weight: 0.8 },
  { code: "ncl", name: "Newcastle", tz: "Australia/Sydney", regs: 1, weight: 0.65 },
] as const;
const FIRST = ["Priya", "Marcus", "Tomas", "Aiko", "Lucy", "Jonah", "Sione", "Mei", "Callum", "Fatima", "Ravi", "Hannah", "Dmitri", "Zoe", "Kofi", "Imogen", "Mateo", "Nadia", "Owen", "Leila"];
const LAST = ["Nair", "Tran", "Okafor", "Whitlam", "Haddad", "Kowalski", "Pereira", "Nguyen", "Brennan", "Sato", "Moana", "Lindqvist", "Adeyemi", "Fraser", "Castellano", "Doyle", "Kaur", "Mazur"];

interface Cat { name: string; taxKey: "gst" | "gst_free"; models: { brand: string; title: string; price: number; cost: number; opts: Record<string, string>[] }[] }
function buildCatalogue(): Cat[] {
  const shoeBrands = ["Tempra", "Valk", "Ostra", "Brisk", "Kinetic"], shoeNames = ["Glide", "Ridge", "Cirrus", "Tempo", "Harrier", "Summit", "Pace", "Drift"], colours = ["Black/White", "Slate", "Ember", "Glacier", "Moss", "Dune"];
  const sizes = ["7", "8", "9", "10", "11", "12"];
  const shoes = Array.from({ length: 36 }, (_, i) => { const price = 12900 + (i % 9) * 1800; return { brand: shoeBrands[i % 5]!, title: `${shoeNames[i % 8]} ${1 + Math.floor(i / 8)}`, price, cost: Math.round(price * 0.52), opts: sizes.map((s) => ({ size: s, colour: colours[i % 6]! })) }; });
  const apparelKinds = ["Run tee", "Long sleeve", "Half tight", "Shorts", "Singlet", "Wind shell", "Fleece", "Cap liner"], sz = ["S", "M", "L", "XL"];
  const apparel = Array.from({ length: 58 }, (_, i) => { const price = 3900 + (i % 8) * 1400; return { brand: shoeBrands[(i + 2) % 5]!, title: `${apparelKinds[i % 8]} ${String.fromCharCode(65 + Math.floor(i / 8))}`, price, cost: Math.round(price * 0.45), opts: sz.flatMap((s) => ["Black", colours[(i + 1) % 6]!].map((c) => ({ size: s, colour: c }))) }; });
  const acc = Array.from({ length: 48 }, (_, i) => { const price = 1200 + (i % 7) * 900; return { brand: shoeBrands[i % 5]!, title: `${["Crew sock", "Trail sock", "Visor", "Belt", "Bottle", "Armband", "Headband", "Gaiter"][i % 8]} ${1 + Math.floor(i / 8)}`, price, cost: Math.round(price * 0.4), opts: [{ colour: "Black" }, { colour: colours[i % 6]! }] }; });
  const fuel = Array.from({ length: 60 }, (_, i) => { const price = 350 + (i % 6) * 120; return { brand: ["Pulse", "Swell", "Kelp"][i % 3]!, title: `${["Gel", "Chew", "Bar", "Electrolyte tab", "Recovery shake", "Salt cap"][i % 6]} ${["Citrus", "Berry", "Salted caramel", "Lime", "Cola", "Ginger", "Peach", "Mint", "Mango", "Apple"][Math.floor(i / 6)]}`, price, cost: Math.round(price * 0.5), opts: [{ pack: "Single" }] }; });
  const rec = Array.from({ length: 34 }, (_, i) => { const price = 2400 + (i % 6) * 1900; return { brand: ["Roll", "Kinetic", "Ostra"][i % 3]!, title: `${["Foam roller", "Massage ball", "Compression sock", "Ice sleeve", "Resistance band", "Insole"][i % 6]} ${1 + Math.floor(i / 6)}`, price, cost: Math.round(price * 0.46), opts: [{ colour: "Black" }, { colour: colours[i % 6]! }] }; });
  return [{ name: "Running shoes", taxKey: "gst", models: shoes }, { name: "Apparel", taxKey: "gst", models: apparel }, { name: "Socks & accessories", taxKey: "gst", models: acc }, { name: "Nutrition", taxKey: "gst_free", models: fuel }, { name: "Recovery", taxKey: "gst", models: rec }];
}

async function main() {
  const reset = process.argv.includes("--reset");
  const url = process.env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline";
  const pool = new pg.Pool({ connectionString: url, max: 3 }); const db = drizzle(pool, { schema });
  if (reset) { await db.execute(sql`drop schema if exists shelfline cascade`); await db.execute(sql`drop schema if exists drizzle cascade`); await runMigrations(url); }
  const existing = await db.execute(sql`select count(*)::int as n from shelfline.location`).catch(() => null);
  if (!existing) throw new Error("The database is not migrated. Run `pnpm --filter @shelfline/api db:migrate` first, or pass --reset.");
  if (Number(existing.rows[0]!.n) > 0) throw new Error("The database already has locations. Pass --reset to rebuild it from scratch.");
  const { orgId } = await seedOrg(db, { orgName: "Kestrel Run Co.", currency: "AUD", timezone: "Australia/Melbourne", ownerEmail: DEMO.owner.email, ownerPassword: DEMO.owner.password, ownerName: "Elena Kestrel" });

  const config = loadConfig({ ...process.env, DATABASE_URL: url, PORT: "0" });
  const app = await NestFactory.create(AppModule.register(config), { logger: ["error"] }); configureApp(app, {});
  await app.listen(0, "127.0.0.1"); const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  const call = async (method: string, path: string, tok: string | null, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text(); if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`); return text ? JSON.parse(text) : null;
  };
  const login = async (e: string, p: string) => (await call("POST", "/auth/login", null, { email: e, password: p })).token as string;
  const owner = await login(DEMO.owner.email, DEMO.owner.password); const O = (m: string, p: string, b?: unknown) => call(m, p, owner, b);
  // loyalty is on from the start, so ninety days of sales build real balances and tiers
  await O("PUT", "/loyalty/program", { enabled: true, pointsPerDollar: 1, tiers: [{ name: "Member", min: 0, multBp: 10000 }, { name: "Silver", min: 300, multBp: 12500 }, { name: "Gold", min: 900, multBp: 15000 }], redeemPoints: 100, redeemValueMinor: 500, birthdayBonus: 50 });
  const t0 = Date.now(); const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${s}`);

  // ---- places, people, devices
  const locs = [] as { code: string; name: string; tz: string; id: string; weight: number; regs: { id: string; code: string; devKey: string; devId: string }[]; staff: { id: string; code: string }[]; customers: string[]; mgr: string }[];
  for (const s of STORES) {
    const loc = await O("POST", "/locations", { code: s.code, name: s.name, type: "store", timezone: s.tz });
    locs.push({ code: s.code, name: s.name, tz: s.tz, id: loc.id, weight: s.weight, regs: [], staff: [], customers: [], mgr: "" });
  }
  const dc = await O("POST", "/locations", { code: "dnd", name: "Dandenong DC", type: "warehouse", timezone: "Australia/Melbourne" });
  await O("POST", "/users", { email: DEMO.hq.email, name: "Dana Whitfield", password: DEMO.hq.password, assignments: [{ role: "hq_manager", locationId: null }] });
  let n = 100;
  for (const l of locs) {
    const mgr = await O("POST", "/users", { email: l.code === "fit" ? DEMO.manager.email : `manager.${l.code}@kestrel.test`, name: l.code === "fit" ? "Marcus Tran" : `${pick(FIRST)} ${pick(LAST)}`, password: DEMO.manager.password, employeeCode: String(++n), pin: DEMO.pin, assignments: [{ role: "store_manager", locationId: l.id }] }); l.mgr = mgr.id; l.staff.push({ id: mgr.id, code: String(n) });
    for (let k = 0; k < 4; k++) { const code = String(++n); const u = await O("POST", "/users", { email: `staff${code}@kestrel.test`, name: `${FIRST[(n + k) % FIRST.length]} ${LAST[(n * 3 + k) % LAST.length]}`, employeeCode: code, pin: DEMO.pin, assignments: [{ role: "cashier", locationId: l.id }] }); l.staff.push({ id: u.id, code }); }
    const cfg = STORES.find((s) => s.code === l.code)!;
    for (let r = 1; r <= cfg.regs; r++) { const reg = await O("POST", `/locations/${l.id}/registers`, { code: `${l.code}-${r}`, name: r === 1 ? "Front desk" : "Side desk" }); const dev = await O("POST", "/devices", { kind: "pos", locationId: l.id, registerId: reg.id, name: `iPad ${l.code.toUpperCase()}-${r}` }); l.regs.push({ id: reg.id, code: reg.code, devKey: dev.key, devId: dev.id }); }
  }
  log(`org, ${locs.length} stores + DC, ${n - 100} people`);

  // ---- catalogue
  const gst = await O("POST", "/tax-classes", { key: "gst", name: "GST 10%" }); const free = await O("POST", "/tax-classes", { key: "gst_free", name: "GST-free" });
  await O("POST", `/tax-classes/${gst.id}/rates`, { rateBp: 1000, inclusive: true, validFrom: "2000-07-01" }); await O("POST", `/tax-classes/${free.id}/rates`, { rateBp: 0, inclusive: true, validFrom: "2000-07-01" });
  const hq = await login(DEMO.hq.email, DEMO.hq.password); const H = (m: string, p: string, b?: unknown) => call(m, p, hq, b);
  const variants = [] as { id: string; price: number; cost: number; cat: number; tax: number; w: number; brand: string }[]; let seqNo = 0;
  const cats = buildCatalogue();
  for (const [ci, cat] of cats.entries()) {
    const c = await H("POST", "/categories", { name: cat.name });
    for (const m of cat.models) {
      const vs = m.opts.map((o) => { seqNo++; return { sku: `${cat.name.slice(0, 2).toUpperCase()}${String(seqNo).padStart(5, "0")}`, barcode: ean13(`93${String(seqNo).padStart(10, "0")}`), options: o, basePriceMinor: m.price, costMinor: m.cost }; });
      const p = await H("POST", "/products", { title: m.title, brand: m.brand, categoryId: c.id, taxClassId: cat.taxKey === "gst" ? gst.id : free.id, variants: vs.map(({ costMinor, ...v }) => v) });
      for (const v of p.variants) variants.push({ id: v.id, price: m.price, cost: m.cost, cat: ci, tax: cat.taxKey === "gst" ? 1000 : 0, w: 0.4 + R() * 1.6, brand: m.brand });
    }
  }
  log(`${variants.length} variants in ${cats.length} categories`);

  // ---- customers (created by a till, the way a cashier would)
  const custCmds = [] as { l: (typeof locs)[number]; id: string; name: string }[];
  for (let i = 0; i < 300; i++) { const l = locs[i % locs.length]!; const id = randomUUID(); l.customers.push(id); custCmds.push({ l, id, name: `${pick(FIRST)} ${pick(LAST)}` }); }

  // ---- generate 90 days of till traffic (in memory first, so stock can be received to match it)
  type Cmd = { type: string; payload: unknown; actorId: string; clientTs: string };
  const streams = new Map<string, Cmd[]>(); const demand = new Map<string, number>(); const need = (loc: string, v: string, q: number) => demand.set(`${loc}|${v}`, (demand.get(`${loc}|${v}`) ?? 0) + q);
  const roster: { l: (typeof locs)[number]; uid: string; date: string }[] = []; const anomalies: string[] = []; const nowMs0 = Date.now(); 
  const cum = (() => { const cw = variants.map((v) => v.w * (v.cat === 0 ? 0.5 : v.cat === 3 ? 1.6 : 1)); let t = 0; const c = cw.map((x) => (t += x)); return { c, t }; })();
  const pickVariant = () => { const x = R() * cum.t; let lo = 0, hi = cum.c.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum.c[mid]! < x) lo = mid + 1; else hi = mid; } return variants[lo]!; };
  const scarce = new Set(Array.from({ length: 6 }, () => pickVariant().id));         // a few variants are deliberately under-stocked so the Alerts screen has real negative-stock rows
  let totalSales = 0, totalRefunds = 0, bigVariance = 0;
  for (const l of locs) for (const reg of l.regs) streams.set(reg.id, []);
  for (const c of custCmds) streams.get(c.l.regs[0]!.id)!.push({ type: "customer.create", payload: { customerId: c.id, name: c.name, email: R() < 0.7 ? `${c.name.toLowerCase().replace(/[^a-z]+/g, ".")}${int(1, 99)}@mail.test` : undefined, marketingConsent: { email: R() < 0.5 } }, actorId: c.l.staff[1]!.id, clientTs: new Date(nowMs0 - (DAYS + 1) * 86_400_000).toISOString() });
  const localDate = (tz: string, at = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  const nowMs = Date.now();
  for (let back = DAYS; back >= 0; back--) {
    for (const l of locs) {
      const date = addDays(localDate(l.tz), -back); const dow = new Date(date + "T12:00:00Z").getUTCDay(); const dayFactor = [0.9, 0.6, 0.65, 0.7, 0.85, 1.15, 1.45][dow]! * (1 + (DAYS - back) / DAYS * 0.18);   // weekends busier, mild growth
      const cfg = STORES.find((s) => s.code === l.code)!;
      for (const [ri, reg] of l.regs.entries()) {
        const out = streams.get(reg.id)!; const sessionId = randomUUID(); const pool = cfg.regs > 1 ? l.staff.slice(1 + ri * 2, 3 + ri * 2) : l.staff.slice(1); const cashier = pool[back % pool.length]!;   // each cashier works one register, so clock punches alternate in/out
        const openAt = zoned(date, "08:30", l.tz) + int(0, 12) * 60_000; const closeAt = zoned(date, "18:00", l.tz) + int(0, 25) * 60_000;
        // Today is partial: only front desks trade, only up to now, and a till still inside its trading hours stays open (the Today screen shows live registers).
        const live = back === 0; if (live && (ri > 0 || nowMs < openAt + 50 * 60_000)) continue;
        const endAt = live ? Math.min(closeAt, nowMs - 60_000) : closeAt; const part = (endAt - openAt) / (closeAt - openAt);
        const nSales = Math.max(live ? 3 : 8, Math.round(int(22, 38) * l.weight * dayFactor * part / (ri ? 1.6 : 1) / (cfg.regs > 1 ? 0.8 : 1)));
        const times = Array.from({ length: nSales }, () => openAt + 20 * 60_000 + Math.floor(R() * (endAt - openAt - 20 * 60_000))).sort((a, b) => a - b);
        const enq = (type: string, payload: unknown, at: number, actorId = cashier.id) => out.push({ type, payload, actorId, clientTs: new Date(at).toISOString() });
        const float = 20_000; let cash = float;
        if (back <= 28) roster.push({ l, uid: cashier.id, date });
        enq("session.open", { sessionId, openingFloatMinor: float }, openAt); enq("punch.record", { punchId: randomUUID(), kind: "in", method: "pin" }, openAt + 30_000);
        const sold: { saleId: string; tender: "cash" | "card" | "other"; lines: { variantId: string; qty: number; unitPriceMinor: number; tax: number; lineTax: number }[]; at: number }[] = [];
        for (const [i, at] of times.entries()) {
          if (R() < 0.09 && sold.length) {                                                          // refund of an earlier sale (whole)
            const s = sold.splice(int(0, sold.length - 1), 1)[0]!; const lines = s.lines.map((x, k) => { return { saleLineNo: k, qty: x.qty, ...refundAmount({ qty: x.qty, refundedQty: 0, totalMinor: x.qty * x.unitPriceMinor, refundedMinor: 0, taxMinor: x.lineTax, refundedTaxMinor: 0 }, x.qty), restock: R() < 0.8 }; });
            const total = lines.reduce((a, x) => a + x.amountMinor, 0); const tender = s.tender === "other" ? "card" : s.tender;
            if (total <= 20_000 && at > s.at) { enq("refund.create", { refundId: randomUUID(), saleId: s.saleId, sessionId, tender, reason: pick(["changed_mind", "faulty", "wrong_size", "wrong_size"] as const), lines, totalMinor: total }, at); totalRefunds += total; if (tender === "cash") cash -= total; }
            continue;
          }
          if (R() < 0.025) { const kind = pick(["no_sale", "pay_out", "drop", "pay_in"] as const); const amt = kind === "no_sale" ? 0 : kind === "drop" ? int(1, 4) * 10_000 : int(5, 40) * 100; enq("cash.move", { movementId: randomUUID(), sessionId, kind, amountMinor: amt, reason: kind === "pay_out" ? pick(["courier", "milk and coffee", "cleaning supplies"]) : kind === "drop" ? "safe drop" : kind === "no_sale" && R() < 0.92 ? pick(["change for customer", "price check", "till check"]) : undefined }, at); if (kind === "pay_in") cash += amt; else if (kind !== "no_sale") cash -= amt; }
          const merged = new Map<string, { variantId: string; qty: number; unitPriceMinor: number; tax: number }>();
          for (let k = 0, kk = R() < 0.55 ? 1 : R() < 0.6 ? 2 : 3; k < kk; k++) { const v = pickVariant(); const q = v.cat === 3 ? int(1, 4) : v.cat === 0 ? 1 : int(1, 2); const e = merged.get(v.id); if (e) e.qty += q; else merged.set(v.id, { variantId: v.id, qty: q, unitPriceMinor: v.price, tax: v.tax }); }
          const ls = [...merged.values()]; const priced = priceCart(ls.map((x) => ({ ...x, discountMinor: 0, tax: { rateBp: x.tax, inclusive: true } })));
          const tender = R() < 0.62 ? "card" : R() < 0.88 ? "cash" : "other"; const saleId = randomUUID(); const cust = R() < 0.28 ? pick(l.customers) : null;
          enq("sale.create", { saleId, sessionId, receiptNo: `${reg.code.toUpperCase()}-${date.replace(/-/g, "").slice(2)}-${String(i + 1).padStart(3, "0")}`, customerId: cust, lines: ls.map((x) => ({ variantId: x.variantId, qty: x.qty, unitPriceMinor: x.unitPriceMinor, discountMinor: 0 })),
            payments: [{ tender, amountMinor: priced.payableMinor, ...(tender === "cash" ? { tenderedMinor: priced.payableMinor + (R() < 0.5 ? (5000 - (priced.payableMinor % 5000)) % 5000 : 0) } : {}) }],
            totals: { subtotalMinor: priced.subtotalMinor, discountMinor: 0, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, roundingMinor: 0, payableMinor: priced.payableMinor }, cashRoundingStep: null }, at);
          totalSales += priced.totalMinor; if (tender === "cash") cash += priced.payableMinor; sold.push({ saleId, tender, lines: ls.map((x, k) => ({ ...x, lineTax: priced.lines[k]!.taxMinor })), at });
          for (const x of ls) need(l.id, x.variantId, x.qty);
        }
        // refunds with restock give stock back, so demand is slightly overstated; that only means a little extra on the shelf
        let counted = cash; const roll = R();
        if (roll < 0.2) counted += pick([-100, -50, 50, 100, -200, 300]); else if (roll < 0.23 && bigVariance < 4) { counted -= int(4, 9) * 1000; bigVariance++; anomalies.push(`${date} ${reg.code}: till short by A$${((cash - counted) / 100).toFixed(2)}`); }
        const forgot = back === 3 && l.code === "fit" && ri === 0; if (forgot) anomalies.push(`${date} FIT-1: ${cashier.id.slice(0, 8)} forgot to clock out`);
        if (!live || endAt >= closeAt) { if (!forgot) enq("punch.record", { punchId: randomUUID(), kind: "out", method: "pin" }, closeAt - 60_000); enq("session.close", { sessionId, countedMinor: Math.max(0, counted) }, closeAt, l.mgr); }
      }
    }
  }
  const nCmds = [...streams.values()].reduce((a, s) => a + s.length, 0); log(`generated ${nCmds} till commands`);

  // ---- stock: stores get what they will sell plus a cushion; the DC holds the depth. A few "scarce" variants are left short on purpose.
  for (const l of locs) {
    const lines = variants.map((v) => { const d = demand.get(`${l.id}|${v.id}`) ?? 0; const base = scarce.has(v.id) ? Math.max(0, Math.floor(d * 0.93)) : d + int(2, 14); return { variantId: v.id, qty: base, unitCostMinor: v.cost }; }).filter((x) => x.qty > 0);
    for (let i = 0; i < lines.length; i += 200) await H("POST", "/inventory/receive", { locationId: l.id, idempotencyKey: randomUUID(), lines: lines.slice(i, i + 200), note: "Opening stock (synthetic demo)" });
  }
  for (let i = 0; i < variants.length; i += 200) await H("POST", "/inventory/receive", { locationId: dc.id, idempotencyKey: randomUUID(), lines: variants.slice(i, i + 200).map((v) => ({ variantId: v.id, qty: int(60, 240), unitCostMinor: v.cost })) });
  log("opening stock received");

  // ---- push every till's stream through the real sync endpoint: customers first (so sales can reference them), then all registers in parallel
  const stats = { accepted: 0, flagged: 0 }; const flagKinds = new Map<string, number>();
  const reg2 = new Map<string, { tok: string; seq: number }>();
  const send = async (regId: string, stream: Cmd[]) => {
    const st = reg2.get(regId)!;
    for (let i = 0; i < stream.length; i += 100) {
      const batch = stream.slice(i, i + 100).map((c) => ({ id: uuidv7(), seq: ++st.seq, type: c.type, payload: c.payload, clientTs: c.clientTs, schemaV: SCHEMA_V, actorId: c.actorId }));
      const res = await call("POST", "/sync/push", st.tok, { deviceNow: new Date().toISOString(), commands: batch });
      for (const r of res.results) {
        if (r.status === "rejected") throw new Error(`a command was rejected: ${r.reason} ${JSON.stringify(r).slice(0, 200)}`);
        if (r.status === "accepted_flagged") { stats.flagged++; for (const f of r.flags ?? []) flagKinds.set(f, (flagKinds.get(f) ?? 0) + 1); } else stats.accepted++;
      }
    }
  };
  for (const l of locs) for (const reg of l.regs) reg2.set(reg.id, { tok: (await call("POST", "/pos/pin", null, { employeeCode: l.staff[1]!.code, pin: DEMO.pin }, { "x-device-key": reg.devKey })).token as string, seq: 0 });
  for (const l of locs) { const r0 = l.regs[0]!.id; const all = streams.get(r0)!; await send(r0, all.filter((c) => c.type === "customer.create")); streams.set(r0, all.filter((c) => c.type !== "customer.create")); }
  const tills = locs.flatMap((l) => l.regs.map((r) => r.id)); let doneTills = 0;
  await Promise.all(tills.map(async (id) => { await send(id, streams.get(id)!); log(`till ${++doneTills}/${tills.length} synced`); }));

  // ---- purchasing history at the distribution centre: suppliers, orders in every state, deliveries, bills (matched, held, overdue, paid)
  const SUPPLIERS = [["Tempra", "Tempra Australia Pty Ltd", 30], ["Valk", "Valk Sports Distribution", 30], ["Ostra", "Ostra Running Co.", 45], ["Brisk", "Brisk Footwear", 14], ["Kinetic", "Kinetic Performance", 30], ["Pulse", "Pulse Nutrition Wholesale", 14], ["Swell", "Swell Fuel Co-op", 14], ["Kelp", "Kelp Labs", 30], ["Roll", "Roll Recovery Supply", 30]] as const;
  const supByBrand = new Map<string, string>(); const termsOf = new Map<string, number>();
  for (const [brand, name, terms] of SUPPLIERS) { const sp = await O("POST", "/suppliers", { name, contactName: `${pick(FIRST)} ${pick(LAST)}`, email: `orders@${brand.toLowerCase()}.test`, phone: `03 9${int(100, 999)} ${int(1000, 9999)}`, termsDays: terms, leadTimeDays: terms >= 45 ? 21 : terms >= 30 ? 14 : 7 }); supByBrand.set(brand, sp.id); termsOf.set(sp.id, terms); }
  const dayAgo = (n: number) => new Date(nowMs - n * 86_400_000).toISOString().slice(0, 10);
  const byBrand = new Map<string, typeof variants>(); for (const v of variants) { const l = byBrand.get(v.brand) ?? []; l.push(v); byBrand.set(v.brand, l); }
  const brands = [...byBrand.keys()].filter((b) => supByBrand.has(b));
  const mkPo = async (brand: string, n: number, state: "draft" | "sent" | "partial" | "received") => {
    const pool = byBrand.get(brand)!; const chosen = new Set<string>(); while (chosen.size < Math.min(n, pool.length)) chosen.add(pick(pool).id);
    const lines = [...chosen].map((id) => { const v = pool.find((x) => x.id === id)!; return { variantId: id, qty: int(2, 6) * 12, unitCostMinor: v.cost }; });
    const po = await O("POST", "/purchase-orders", { supplierId: supByBrand.get(brand), locationId: dc.id, expectedOn: dayAgo(-int(3, 20)), note: state === "draft" ? "Replenishment, awaiting sign-off" : undefined, lines });
    if (state === "draft") return { po, lines, detail: null as any };
    await O("POST", `/purchase-orders/${po.id}/send`);
    let detail = await O("GET", `/purchase-orders/${po.id}`);
    if (state === "partial" || state === "received") {
      const take = (l: any) => (state === "received" ? l.qtyOrdered : Math.floor(l.qtyOrdered * 0.6));
      await O("POST", `/purchase-orders/${po.id}/receive`, { idempotencyKey: randomUUID(), lines: detail.lines.map((l: any) => ({ poLineId: l.id, qty: take(l) })), freightMinor: int(4, 14) * 1000, otherCostMinor: R() < 0.3 ? int(1, 5) * 500 : 0 });
      detail = await O("GET", `/purchase-orders/${po.id}`);
    }
    return { po, lines, detail };
  };
  let nBills = 0; const billFor = async (x: { po: any; detail: any }, brand: string, ago: number, mode: "matched" | "over" | "price", payShare: number) => {
    const sid = supByBrand.get(brand)!; const bd = dayAgo(ago); const number = `${brand.slice(0, 3).toUpperCase()}-${String(++nBills + 40_000)}`;
    const lines = x.detail.lines.filter((l: any) => l.qtyReceived > 0).map((l: any) => ({ poLineId: l.id, variantId: l.variantId, description: `${l.title} ${l.sku}`, qty: mode === "over" ? l.qtyOrdered : l.qtyReceived, unitCostMinor: mode === "price" ? l.unitCostMinor + 25 : l.unitCostMinor }));
    const b = await O("POST", "/bills", { supplierId: sid, poId: x.po.id, number, billDate: bd, lines: [...lines, { description: "Freight", qty: 1, unitCostMinor: int(4, 14) * 1000 }] });
    if (mode === "matched" && payShare > 0) { const total = b.totalMinor; const part = payShare >= 1 ? total : Math.round(total * payShare); await O("POST", `/bills/${b.id}/payments`, { amountMinor: part, paidOn: dayAgo(Math.max(1, ago - 12)), method: pick(["bank_transfer", "bank_transfer", "card"] as const), reference: `EFT ${int(1000, 9999)}`, idempotencyKey: randomUUID() }); }
    return b;
  };
  for (let i = 0; i < 12; i++) { const brand = brands[i % brands.length]!; const x = await mkPo(brand, int(8, 22), "received"); await billFor(x, brand, 82 - i * 6, "matched", i < 7 ? 1 : i < 9 ? 0.5 : 0); }   // older ones paid, the newest still owed
  { const brand = brands[0]!; const x = await mkPo(brand, 14, "partial"); await billFor(x, brand, 9, "over", 0); anomalies.push(`purchasing: ${brand} order part delivered, bill claims all of it (held, over-billed)`); }
  { const brand = brands[1]!; const x = await mkPo(brand, 10, "received"); await billFor(x, brand, 11, "price", 0); anomalies.push(`purchasing: ${brand} bill priced above the order (held, price variance)`); }
  { const brand = brands[2]!; const x = await mkPo(brand, 12, "partial"); await billFor(x, brand, 6, "matched", 0); }
  for (const [brand, st] of [[brands[3]!, "sent"], [brands[4]!, "sent"], [brands[0]!, "sent"], [brands[1]!, "draft"], [brands[2]!, "draft"]] as const) await mkPo(brand, int(6, 16), st);
  await O("PUT", "/accounting/accounts", { items: Object.entries({ cash: ["1000", "Cash on hand"], card_clearing: ["1010", "Card clearing"], gift_card_liability: ["2100", "Gift cards outstanding"], store_credit_liability: ["2110", "Store credit"], other_clearing: ["1020", "Other clearing"], sales_revenue: ["4000", "Sales"], gst_collected: ["2200", "GST collected"], rounding: ["4900", "Rounding"], cash_over_short: ["4910", "Cash over/short"], cogs: ["5000", "Cost of goods sold"], inventory: ["1200", "Inventory"], suspense: ["9999", "Suspense"] }).map(([key, [code, name]]) => ({ key, code, name })) });
  log("suppliers, purchase orders, deliveries and bills created; chart of accounts mapped");

  // ---- commission: a general rate shared by whoever is on, a richer brand rate on margin, fortnightly periods (the oldest four closed)
  const since = dayAgo(95);
  await O("POST", "/commission/rules", { scopeKind: "default", validFrom: since, basis: "net_ex_tax", rateBp: 300, splitMode: "equal", note: "House rate: 3% of the sale without GST, shared by everyone clocked in" });
  await O("POST", "/commission/rules", { scopeKind: "brand", scopeValue: brands[0]!, validFrom: since, basis: "margin", rateBp: 800, splitMode: "seller", note: "Push brand: 8% of margin to the seller" });
  await O("POST", "/commission/rules", { scopeKind: "default", validFrom: dayAgo(30), basis: "net_ex_tax", rateBp: 350, splitMode: "equal", note: "Raised after the winter targets were met" });
  for (let i = 0; i < 4; i++) { const per = await O("POST", "/commission/periods", { from: dayAgo(90 - 14 * i), to: dayAgo(77 - 14 * i) }); await O("POST", `/commission/periods/${per.id}/lock`); }
  await O("POST", "/commission/periods", { from: dayAgo(34), to: dayAgo(21) }); await O("POST", "/commission/periods", { from: dayAgo(20), to: dayAgo(7) }); await O("POST", "/commission/periods", { from: dayAgo(6), to: dayAgo(-7) });
  await O("POST", "/commission/recalculate"); anomalies.push("commission: four fortnights closed, three open (the last one runs through today)");
  log("commission rules, periods and statements created");

  // ---- report access: an accountant who sees everything but cost, an area manager with two stores, and one that was withdrawn
  {
    const locs = (await O("GET", "/locations")) as { id: string; name: string; type: string }[]; const stores = locs.filter((l) => l.type === "store");
    await O("POST", "/report-grants", { email: "ines.walker@brightledger.test", name: "Ines Walker (Bright Ledger, accountants)", reportKeys: ["sales", "cash_variance"], locationIds: null, rangeKind: "rolling", rollingDays: 90, hiddenColumns: ["costMinor"] });
    await O("POST", "/report-grants", { email: "sam.okoro@kestrel.test", name: "Sam Okoro (area manager)", reportKeys: ["sales"], locationIds: stores.filter((l) => /Fitzroy|South Yarra/.test(l.name)).map((l) => l.id), rangeKind: "rolling", rollingDays: 30, hiddenColumns: [] });
    const old = await O("POST", "/report-grants", { email: "tom.reyes@oldfirm.test", name: "Tom Reyes (former bookkeeper)", reportKeys: ["sales"], locationIds: null, rangeKind: "fixed", rangeFrom: dayAgo(180), rangeTo: dayAgo(91), hiddenColumns: ["costMinor"] });
    await O("POST", `/report-grants/${old.id}/revoke`); anomalies.push("report access: 3 readers (Ines Walker without cost, Sam Okoro two stores, one withdrawn); sign in at the portal with a code from GET /dev/mailbox");
  }
  log("report access grants created");

  // ---- notification rules: what the owner and the store managers are told, and when they are left alone
  {
    await O("POST", "/notification-rules", { name: "No-sales to store managers", eventKind: "no_sale", locationIds: null, recipientRoles: ["store_manager", "owner"], channels: ["in_app"], quietStart: "22:00", quietEnd: "07:00" });
    await O("POST", "/notification-rules", { name: "Short or over drawer (more than A$10)", eventKind: "cash_variance", conditions: { varianceOverMinor: 1000 }, recipientRoles: ["store_manager", "owner"], channels: ["in_app", "email"] });
    await O("POST", "/notification-rules", { name: "Refunds of A$150 or more", eventKind: "large_refund", conditions: { minMinor: 15000 }, recipientRoles: ["owner"], channels: ["in_app", "email"], digest: true, digestAt: "18:00" });
    await O("POST", "/notification-rules", { name: "Late arrivals (10 minutes or more)", eventKind: "late_arrival", conditions: { minLateMinutes: 10 }, recipientRoles: ["store_manager"], channels: ["in_app"] });
    anomalies.push("notifications: 4 rules (no-sale, drawer variance, large refunds in a daily summary, late arrivals); try a no-sale on a till to see one arrive in the Inbox");
  }
  log("notification rules created");

  // ---- end-of-day report: one for every store, sent at 21:30 Melbourne time as a PDF
  await O("POST", "/eod-schedules", { name: "Owner's end of day", locationIds: null, sendAtLocal: "21:30", timezone: "Australia/Melbourne", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], methods: ["email"], recipients: ["elena@kestrel.test"], format: "pdf", onlyWhenClosed: true, maxWaitMinutes: 120 });
  anomalies.push("end of day: schedule for all stores at 21:30 Melbourne time; \"Send a test now\" in Admin > End of day");
  log("end-of-day schedule created");

  // ---- a receipt printer and a card terminal at Fitzroy (the printer is the virtual one: `go run ./cmd/virtualprinter` in apps/bridge)
  {
    const locs = (await O("GET", "/locations")) as { id: string; name: string; type: string }[]; const fit = locs.find((l) => l.name === "Fitzroy");
    if (fit) { await O("POST", "/printers", { locationId: fit.id, name: "Front desk printer", host: "127.0.0.1", port: 9100, columns: 42 }); await O("POST", "/card-readers", { locationId: fit.id, name: "Counter terminal", providerReaderId: "tmr_DEMO" }); anomalies.push("devices: Fitzroy has a receipt printer at 127.0.0.1:9100 (run the virtual printer and a paired bridge) and a simulated card terminal (cents ending 13 are declined, 77 wait for a tap)"); }
  }

  // ---- marketing: a group, a draft campaign, the automatic emails (off), and a few birthdays today so "Check now" has something to do
  {
    await O("POST", "/marketing/segments", { name: "Haven't bought in 90 days", rules: { lastPurchaseBeforeDays: 90 } }); await O("POST", "/marketing/segments", { name: "Silver and Gold members", rules: { tiers: ["Silver", "Gold"] } });
    const seg = (await O("GET", "/marketing/segments")) as { id: string; name: string }[]; const gold = seg.find((x) => /Silver/.test(x.name))!;
    await O("POST", "/marketing/campaigns", { name: "Members' weekend", segmentId: gold.id, subject: "{{first_name}}, a weekend for our {{tier}} members", body: "Hi {{first_name}},\n\nYou have {{points}} points. This weekend they go further.\n\nSee you in store." });
    await O("GET", "/marketing/flows");
    await db.execute(sql`update shelfline.customer set birth_month = extract(month from now())::int, birth_day = extract(day from now())::int where id in (select id from shelfline.customer where marketing_consent->>'email' = 'true' and email is not null order by name limit 3)`);
    anomalies.push("marketing: 2 saved groups, a draft campaign for Silver and Gold members, three automatic emails (off) and three customers with a birthday today; loyalty is on (Silver from 300 points, Gold from 900)");
  }
  log("marketing and loyalty set up");

  // ---- stock movement between places and stock counts
  const pickVs = (n: number) => { const u = new Set<string>(); while (u.size < n) u.add(pick(variants).id); return [...u]; };
  const xfer = async (to: (typeof locs)[number], n: number, how: "received" | "short" | "partial" | "transit" | "draft" | "stuck") => {
    const ids = pickVs(n); const t = await O("POST", "/transfers", { fromLocationId: dc.id, toLocationId: to.id, note: "Weekly top-up", lines: ids.map((variantId) => ({ variantId, qty: int(2, 8) * 2 })) });
    if (how === "draft") return t;
    await O("POST", `/transfers/${t.id}/send`); const d = await O("GET", `/transfers/${t.id}`);
    if (how === "received") await O("POST", `/transfers/${t.id}/receive`, { idempotencyKey: randomUUID(), lines: d.lines.map((l: any) => ({ lineId: l.id, qty: l.qtySent })) });
    if (how === "short") await O("POST", `/transfers/${t.id}/receive`, { idempotencyKey: randomUUID(), closeShort: true, lines: d.lines.map((l: any, i: number) => ({ lineId: l.id, qty: i === 0 ? l.qtySent - 1 : l.qtySent })) });
    if (how === "partial") await O("POST", `/transfers/${t.id}/receive`, { idempotencyKey: randomUUID(), lines: d.lines.map((l: any) => ({ lineId: l.id, qty: Math.floor(l.qtySent / 2) })).filter((l: any) => l.qty > 0) });
    if (how === "stuck") await db.execute(sql`update shelfline.transfer set sent_at = now() - interval '10 days' where id = ${t.id}`);
    return t;
  };
  for (const [l, how] of [[locs[0]!, "received"], [locs[1]!, "received"], [locs[2]!, "short"], [locs[3]!, "received"], [locs[1]!, "partial"], [locs[0]!, "transit"], [locs[2]!, "stuck"], [locs[3]!, "draft"]] as const) await xfer(l, int(4, 9), how);
  const cat0 = (await O("GET", "/categories"))[1];
  const done = await O("POST", "/stock-counts", { locationId: locs[0]!.id, mode: "cycle", categoryId: cat0.id, blind: true });
  { const full = await O("GET", `/stock-counts/${done.id}`); const withStock = await O("GET", `/inventory?locationId=${locs[0]!.id}&limit=200`); const have = new Map<string, number>(withStock.map((r: any) => [r.variantId, r.onHand])); await O("PUT", `/stock-counts/${done.id}/lines`, { lines: full.lines.slice(0, 60).map((l: any, i: number) => ({ variantId: l.variantId, countedQty: Math.max(0, (have.get(l.variantId) ?? 0) + (i % 7 === 0 ? -1 : i % 11 === 0 ? 1 : 0)) })) }); }
  await O("POST", `/stock-counts/${done.id}/submit`); await O("POST", `/stock-counts/${done.id}/commit`, { uncounted: "skip" }).catch(() => undefined);
  const rev = await O("POST", "/stock-counts", { locationId: locs[1]!.id, mode: "cycle", categoryId: (await O("GET", "/categories"))[3].id, blind: true }); { const r = await O("GET", `/stock-counts/${rev.id}`); await O("PUT", `/stock-counts/${rev.id}/lines`, { lines: r.lines.slice(0, 25).map((l: any, i: number) => ({ variantId: l.variantId, countedQty: i % 5 === 0 ? 0 : 3 })) }); await O("POST", `/stock-counts/${rev.id}/submit`); }
  await O("POST", "/stock-counts", { locationId: locs[3]!.id, mode: "full", blind: true });
  log("transfers and stock counts created");

  // ---- price books and promotions, starting tomorrow so none of the history above is (wrongly) judged against them
  const ymdPlus = (n: number) => new Date(nowMs + n * 86_400_000).toISOString().slice(0, 10);
  const shoes = variants.filter((v) => v.cat === 0), tees = variants.filter((v) => v.cat === 1).slice(0, 40), socks = variants.filter((v) => v.cat === 2).slice(0, 30);
  const mkBook = async (name: string, priority: number, from: string | null, to: string | null, where: string[], items: { id: string; price: number }[]) => {
    const b = await H("POST", "/price-books", { name, priority, validFrom: from, validTo: to, locationIds: where }); for (let i = 0; i < items.length; i += 500) await H("PUT", `/price-books/${b.id}/entries`, { set: items.slice(i, i + 500).map((x) => ({ variantId: x.id, priceMinor: x.price })) }); return b;
  };
  const melb = locs.filter((l) => l.tz === "Australia/Melbourne").map((l) => l.id);
  await mkBook("Spring running sale", 50, ymdPlus(1), ymdPlus(30), melb, shoes.map((v) => ({ id: v.id, price: Math.round((v.price * 0.85) / 100) * 100 - 5 })));
  await mkBook("Newcastle opening prices", 60, ymdPlus(1), ymdPlus(14), [locs[3]!.id], shoes.slice(0, 20).map((v) => ({ id: v.id, price: Math.round((v.price * 0.8) / 100) * 100 - 5 })));
  await mkBook("Summer clearance (ended)", 40, ymdPlus(-70), ymdPlus(-40), [], shoes.slice(0, 12).map((v) => ({ id: v.id, price: Math.round((v.price * 0.7) / 100) * 100 - 5 })));
  await H("POST", "/promotions", { name: "Tee deal 10% off", kind: "percent", valueBp: 1000, validFrom: ymdPlus(1), validTo: ymdPlus(21), variantIds: tees.map((v) => v.id) });
  await H("POST", "/promotions", { name: "Sock bundle: A$1.50 off each, buy 3+", kind: "amount_off", amountMinor: 150, minQty: 3, validFrom: ymdPlus(1), variantIds: socks.map((v) => v.id) });
  await H("POST", "/promotions", { name: "Member week 5% off", kind: "percent", valueBp: 500, stackable: true, validFrom: ymdPlus(3), validTo: ymdPlus(10) });
  log("price books and promotions created");

  // ---- gift cards and store credit (codes are shown once, so the demo prints a few for trying at the till)
  const demoCodes: string[] = [];
  for (let i = 0; i < 14; i++) { const g = await O("POST", "/gift-cards", { amountMinor: pick([2500, 5000, 5000, 10000, 15000]), note: pick(["Birthday", "Christmas", "Race day", "Staff reward", "Online order"]), expiresOn: i % 5 === 0 ? ymdPlus(200) : null }); if (i < 3) demoCodes.push(g.code); if (i % 4 === 0) await O("POST", `/gift-cards/${g.id}/topup`, { amountMinor: 2500, idempotencyKey: randomUUID() }); if (i === 13) await O("PATCH", `/gift-cards/${g.id}`, { status: "void" }); }
  for (let i = 0; i < 8; i++) await O("POST", `/customers/${pick(locs).customers[i]!}/credit`, { amountMinor: pick([1500, 2000, 4500, 6000]), idempotencyKey: randomUUID(), note: pick(["Refund credit", "Goodwill", "Faulty pair, credit agreed"]) });
  await O("PATCH", `/locations/${locs[2]!.id}`, { giftCardOffline: true, giftCardOfflineCapMinor: 2500 });
  log("gift cards and store credit created");

  // ---- the roster: published shifts for the last four weeks (matching who actually worked) and the coming week, templates and staffing need
  for (const [name, a, b, r] of [["Opening", "08:30", "17:00", "Opening"], ["Mid", "10:00", "18:30", "Floor"], ["Close", "12:00", "20:30", "Closing"]] as const) await O("POST", "/shift-templates", { name, startTime: a, endTime: b, role: r, breakMinutes: 30 });
  for (const l of locs) await O("PUT", `/locations/${l.id}/staffing`, { 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 0: 1 });
  const upcoming: typeof roster = []; for (let d = 1; d <= 7; d++) for (const l of locs) for (const [k, st] of l.staff.slice(1, 3).entries()) if ((d + k) % 3 !== 0) upcoming.push({ l, uid: st.id, date: addDays(localDate(l.tz), d) });
  for (const r of [...roster, ...upcoming]) await O("POST", "/shifts", { locationId: r.l.id, userId: r.uid, date: r.date, start: "08:30", end: "18:00", breakMinutes: 30, role: "Floor" }).catch(() => undefined);
  for (const l of locs) { const t = localDate(l.tz); await O("POST", "/shifts/publish", { locationId: l.id, from: addDays(t, -29), to: addDays(t, 0) }); await O("POST", "/shifts/publish", { locationId: l.id, from: addDays(t, 1), to: addDays(t, 7) }); }
  await O("POST", "/shifts", { locationId: locs[0]!.id, userId: null, date: addDays(localDate(locs[0]!.tz), 2), start: "10:00", end: "18:30", role: "Floor", breakMinutes: 30 });
  log("roster created");

  // ---- attendance terminals: one registered terminal per store, a paired bridge at Fitzroy, and one record nobody could match (held for review)
  const { createHmac } = await import("node:crypto");
  for (const [i, l] of locs.entries()) await O("POST", "/terminals", { locationId: l.id, serial: `CGRC00000${i + 1}`, name: i === 0 ? "Staff door" : "Back door" });
  const br = await O("POST", "/bridges", { locationId: locs[0]!.id, name: "Back office mini PC" }); const paired = await call("POST", "/devices/pair", null, { pairingCode: br.pairingCode });
  const evBody = JSON.stringify({ events: [{ serial: "CGRC000001", personCode: "4242", ts: new Date(nowMs - 25 * 60_000).toISOString(), verify: "fingerprint" }] }); const tsec = String(Math.floor(Date.now() / 1000));
  await call("POST", "/devices/punches", null, undefined, { "x-bridge-id": paired.bridgeId, "x-timestamp": tsec, "x-signature": createHmac("sha256", paired.secret).update(`${tsec}.${evBody}`).digest("hex") }, evBody);
  await O("POST", "/bridges", { locationId: locs[1]!.id, name: "South Yarra PC (not paired yet)" });
  log("terminals created");

  // ---- proof
  // ---- online store: Fitzroy and South Yarra take pickups, and a few customers have reserved things
  {
    const locs = (await O("GET", "/locations")) as { id: string; name: string; type: string }[]; const stores = locs.filter((l) => /Fitzroy|South Yarra/.test(l.name));
    for (const l of stores) await O("PATCH", `/locations/${l.id}`, { pickupEnabled: true });
    const fit = stores.find((l) => l.name === "Fitzroy")!; const pickable = (await db.execute(sql`select b.variant_id from shelfline.stock_balance b where b.location_id = ${fit.id} and b.on_hand >= 6 limit 4`)).rows as { variant_id: string }[];
    const place = async (name: string, email: string, lines: { variantId: string; qty: number }[]) => (await fetch(`${base}/shop/${orgId}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name, locationId: fit.id, lines }) })).json() as Promise<{ id: string; pickupCode: string }>;
    const people = [["Alex Morgan", "alex.morgan@example.com"], ["Jo Nguyen", "jo.nguyen@example.com"], ["Chris Patel", "chris.patel@example.com"]] as const; const made: { id: string; pickupCode: string }[] = [];
    for (const [i, [n, e]] of people.entries()) if (pickable[i]) made.push(await place(n, e, [{ variantId: pickable[i]!.variant_id, qty: 1 + i }]));
    if (made[0]) await O("POST", `/online-orders/${made[0].id}/ready`);
    anomalies.push(`online store: Fitzroy and South Yarra take pickups; ${made.length} orders reserved at Fitzroy (one ready); pickup code for the first: ${made[0]?.pickupCode ?? "n/a"}. The storefront (apps/storefront) shows the same stock`);
  }
  log("online store set up");

  const ledger = app.get(LedgerService); const bad = await ledger.check(orgId);
  const q = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows[0] as Record<string, string>;
  const counts = await q(sql`select (select count(*) from shelfline.sale) sales, (select count(*) from shelfline.refund) refunds, (select count(*) from shelfline.register_session) sessions, (select count(*) from shelfline.customer) customers, (select count(*) from shelfline.variant) variants, (select count(*) from shelfline.stock_movement) movements, (select count(*) from shelfline.sync_exception where status = 'open') open_exceptions, (select count(*) from shelfline.purchase_order) purchase_orders, (select count(*) from shelfline.supplier_bill) bills, (select count(*) from shelfline.supplier_bill where status = 'held') bills_on_hold, (select count(*) from shelfline.transfer) transfers, (select count(*) from shelfline.stock_count) stock_counts, (select count(*) from shelfline.price_book) price_books, (select count(*) from shelfline.promotion) promotions, (select count(*) from shelfline.gift_card) gift_cards, (select count(*) from shelfline.balance_entry) balance_entries, (select count(*) from shelfline.shift) shifts, (select count(*) from shelfline.terminal) terminals, (select count(*) from shelfline.terminal_event where status = 'needs_review') held_records`);
  console.log("\nKestrel Run Co. (synthetic demo data)\n" + Object.entries(counts).map(([k, v]) => `  ${k.padEnd(16)} ${v}`).join("\n"));
  console.log(`  ledger check     ${bad.length === 0 ? "OK (stock balances equal the sum of movements)" : "FAILED " + JSON.stringify(bad.slice(0, 3))}`);
  console.log(`  sales A$${(totalSales / 100).toFixed(0)}, refunds A$${(totalRefunds / 100).toFixed(0)}; accepted ${stats.accepted}, accepted with a flag ${stats.flagged} ${[...flagKinds].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (anomalies.length) console.log("  planted for the demo:\n" + anomalies.map((a) => "    " + a).join("\n"));
  if (demoCodes.length) console.log(`  gift cards to try at the till (shown once): ${demoCodes.join("   ")}`);
  console.log(`\nSign in (admin): ${DEMO.owner.email} / ${DEMO.owner.password}   |   till PIN for staff codes 101-120: ${DEMO.pin}`);
  const devices = locs.flatMap((l) => l.regs.map((r) => ({ store: l.name, register: r.code, deviceKey: r.devKey, apiUrl: process.env.PUBLIC_API_URL ?? "http://localhost:8200", employeeCode: l.staff[1]!.code, pin: DEMO.pin, managerCode: l.staff[0]!.code })));
  const { writeFileSync } = await import("node:fs"); writeFileSync(new URL("../.demo-devices.json", import.meta.url), JSON.stringify(devices, null, 2));
  console.log("  till device keys written to apps/api/.demo-devices.json (shown once; pair an iPad or the browser with one of them)");
  await app.close(); await pool.end();
  if (bad.length) process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
