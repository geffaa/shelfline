import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { priceCart } from "@shelfline/pricing";
import { backupRestoreCheck, fingerprint } from "../src/ops/backup";
import { posWorld, reset, startApp, type Harness } from "./helpers";

const haveTools = (() => { try { execFileSync("pg_dump", ["--version"]); execFileSync("pg_restore", ["--version"]); return true; } catch { return false; } })();
let h: Harness;
beforeAll(async () => { h = await startApp(); }, 60_000);
afterAll(async () => { await h.close(); });

describe.skipIf(!haveTools)("backup and restore", () => {
  it("a dump restored into a fresh database is the same database: every row, every sequence, the security rules and the immutability triggers", async () => {
    await reset(h); const w = await posWorld(h, { stock: 50 }); const session = randomUUID(); await w.push([w.cmd("session.open", { sessionId: session, openingFloatMinor: 10000 })]);
    for (let i = 0; i < 12; i++) {
      const ls = [{ variantId: w.v[i % 3]!.id, qty: 1 + (i % 3), unitPriceMinor: [21995, 8900, 3400][i % 3]!, discountMinor: 0 }]; const p = priceCart(ls.map((l) => ({ ...l, tax: { rateBp: 1000, inclusive: true } }))); const saleId = randomUUID();
      expect((await w.push([w.cmd("sale.create", { saleId, sessionId: session, receiptNo: `R-${i}-${saleId.slice(0, 4)}`, customerId: null, lines: ls, payments: [{ tender: i % 2 ? "cash" : "card", amountMinor: p.payableMinor }], totals: { subtotalMinor: p.subtotalMinor, discountMinor: 0, taxMinor: p.taxMinor, totalMinor: p.totalMinor, roundingMinor: 0, payableMinor: p.payableMinor }, cashRoundingStep: null })])).body.results[0].status).toMatch(/accepted/);
    }
    await w.owner.post("/suppliers", { name: "Backed-up supplier" });
    const r = await backupRestoreCheck(h.config.databaseUrl); expect(r.mismatches).toEqual([]); expect(r.ok).toBe(true); expect(r.rows).toBeGreaterThan(100); expect(r.tables).toBeGreaterThan(60);
    // and the check can fail: change one cent after fingerprinting a copy
    const before = await fingerprint(h.config.databaseUrl); await h.db.execute(sql`update shelfline.sale set total_minor = total_minor + 1 where id = (select id from shelfline.sale limit 1)`);
    const after = await fingerprint(h.config.databaseUrl); expect(after.tables.sale!.hash).not.toBe(before.tables.sale!.hash); expect(after.tables.stock_movement!.hash).toBe(before.tables.stock_movement!.hash);
  }, 120_000);
});
