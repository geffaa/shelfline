import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { priceCart } from "@shelfline/pricing";
import { posWorld, reset, startApp, type Harness } from "./helpers";

/**
 * Performance budgets. Each is a ceiling for the 95th percentile of one request against a store with a few thousand sales, run on a laptop
 * with the database in a container. They are deliberately 3-10x what was measured when they were set (see docs/PERFORMANCE.md), so a
 * slow machine does not fail the build but an accidental full-table scan or an N+1 loop does. PERF_SALES changes the data size.
 */
const SALES = Number(process.env.PERF_SALES ?? 3000); const BATCH = 25;
export const BUDGET_MS = { saleBatchPush: 600, productSearch: 40, ordersList: 60, overview: 100, salesReport: 80, syncPull: 60, replenishment: 120, accountingDay: 120 } as const;

let h: Harness; let w: Awaited<ReturnType<typeof posWorld>>; const measured: Record<string, number[]> = {};
async function time<T>(name: string, fn: () => Promise<T>): Promise<T> { const t = performance.now(); const r = await fn(); (measured[name] ??= []).push(performance.now() - t); return r; }
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)]!;

beforeAll(async () => {
  h = await startApp(); await reset(h); w = await posWorld(h, { stock: SALES * 3 }); const session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 10000 })]);
  for (let b = 0; b < SALES / BATCH; b++) {
    const cmds = Array.from({ length: BATCH }, (_, i) => { const k = b * BATCH + i; const ls = [{ variantId: w.v[k % 3]!.id, qty: 1 + (k % 2), unitPriceMinor: [21995, 8900, 3400][k % 3]!, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } })));
      return w.cmd("sale.create", { saleId: randomUUID(), sessionId: session, receiptNo: `P-${k}`, customerId: null, lines: ls, payments: [{ tender: k % 2 ? "cash" : "card", amountMinor: p.payableMinor }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null }); });
    const r = await time("saleBatchPush", () => w.push(cmds)); expect(r.body.results.every((x: { status: string }) => /accepted/.test(x.status))).toBe(true);
  }
  await h.db.execute(sql`analyze`);
}, 600_000);
afterAll(async () => { process.stderr.write(`PERF p95 ms ${SALES} sales: ${JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, Math.round(p95(v))])))}\n`); await h.close(); });

const repeat = async (name: string, n: number, fn: () => Promise<{ status: number }>) => { await fn(); for (let i = 0; i < n; i++) expect((await time(name, fn)).status).toBe(200); };

describe(`budgets with ${SALES} sales`, () => {
  it("the data is what we think it is", async () => { expect((await h.db.execute(sql`select count(*)::int as n from shelfline.sale`)).rows[0]!.n).toBe(SALES); });
  it("a till pushing 25 sales at once", () => { expect(p95(measured.saleBatchPush!)).toBeLessThan(BUDGET_MS.saleBatchPush); });
  it("searching the catalogue", async () => { await repeat("productSearch", 30, () => w.hqApi.get("/products?q=glide")); expect(p95(measured.productSearch!)).toBeLessThan(BUDGET_MS.productSearch); });
  it("the orders list", async () => { await repeat("ordersList", 20, () => w.owner.get("/orders?limit=50")); expect(p95(measured.ordersList!)).toBeLessThan(BUDGET_MS.ordersList); });
  it("the Today overview", async () => { await repeat("overview", 20, () => w.owner.get("/overview")); expect(p95(measured.overview!)).toBeLessThan(BUDGET_MS.overview); });
  it("a sales report over everything", async () => { await repeat("salesReport", 20, () => w.owner.get("/reports/sales?groupBy=day&from=2020-01-01&to=2099-12-31")); expect(p95(measured.salesReport!)).toBeLessThan(BUDGET_MS.salesReport); });
  it("a till catching up on the change log", async () => { await repeat("syncPull", 20, () => h.http().get("/sync/pull?limit=200").set("Authorization", `Bearer ${w.tok}`)); expect(p95(measured.syncPull!)).toBeLessThan(BUDGET_MS.syncPull); });
  it("reorder suggestions", async () => { await repeat("replenishment", 10, () => w.owner.get(`/replenishment?locationId=${w.fitzroy.id}&scope=network`)); expect(p95(measured.replenishment!)).toBeLessThan(BUDGET_MS.replenishment); });
  it("a day's journal", async () => { const day = (await h.db.execute(sql`select local_date::text as d from shelfline.sale limit 1`)).rows[0]!.d as string; await repeat("accountingDay", 10, () => w.owner.get(`/accounting/day?locationId=${w.fitzroy.id}&date=${day}`)); expect(p95(measured.accountingDay!)).toBeLessThan(BUDGET_MS.accountingDay); });
});
