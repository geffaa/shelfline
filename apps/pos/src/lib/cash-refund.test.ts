import { describe, expect, it } from "vitest";
import { CashMove, RefundCreate, SessionClose } from "@shelfline/contracts";
import { MemoryStore } from "@shelfline/sync-client";
import { clockState, closeRegister, provisionalZ, recordMove, recordPunch, type LocalRefund } from "./cash";
import { completeRefund, fromLocal, maxRefundable, planRefund } from "./refunds";
import type { LocalSale, LocalSession } from "./sales";

const session: LocalSession = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", openedAt: "2026-11-04T08:57:00Z", openingFloatMinor: 30000, cashierId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", cashierName: "Priya N." };
const sale = (id: string, total: number, tender: "cash" | "card" | "other", qty = 1, tax = Math.round(total / 11)): LocalSale => ({
  id, receiptNo: `FIT-2-${id}`, at: "2026-11-04T09:00:00Z", cashierName: "Priya N.", customerName: null, registerCode: "FIT-2", sessionId: session.id,
  lines: [{ lineNo: 0, variantId: "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv", title: "Tempra Glide 3", optionsLabel: "10.5", qty, unitPriceMinor: total / qty, discountMinor: 0, totalMinor: total, taxMinor: tax, refundedQty: 0, refundedMinor: 0, refundedTaxMinor: 0 }],
  totals: { subtotalMinor: total, discountMinor: 0, taxMinor: tax, totalMinor: total, roundingMinor: 0, payableMinor: total }, payments: [{ tender, amountMinor: total }], changeMinor: 0,
});

describe("provisional Z (same arithmetic as the server)", () => {
  it("reproduces the close sheet of the admin mockup: expected A$1,215.40, net A$4,602.00", async () => {
    const s = new MemoryStore();
    await s.transact(async (tx) => {
      for (const x of [sale("s1", 139740, "cash"), sale("s2", 8900, "cash", 10), sale("s3", 308460, "card"), sale("s4", 11995, "card"), sale("s5", 12000, "other")]) await tx.put("sales", x.id, x);
      const r = (id: string, saleId: string, total: number, tender: "cash" | "card", tax: number): LocalRefund => ({ id, saleId, receiptNo: "x", sessionId: session.id, tender, totalMinor: total, taxMinor: tax, reason: "faulty", at: "2026-11-04T10:00:00Z", lines: [] });
      await tx.put("refunds", "r1", r("r1", "s2", 8900, "cash", 809)); await tx.put("refunds", "r2", r("r2", "s4", 11995, "card", 1090));
    });
    for (const [kind, amountMinor, reason] of [["pay_in", 5000, "change"], ["pay_out", 3200, "courier"], ["drop", 50000, "drop"], ["no_sale", 0, "change for customer"]] as const) await recordMove(s, { session, cashierId: session.cashierId, kind, amountMinor, reason });
    const z = await provisionalZ(s, session);
    expect(z).toMatchObject({ expectedMinor: 121540, salesCount: 5, grossSalesMinor: 481095, refundsMinor: 20895, netSalesMinor: 460200, noSaleCount: 1, tenders: { cashMinor: 148640, cardMinor: 320455, otherMinor: 12000 }, cash: { refundsMinor: 8900, payInMinor: 5000, payOutMinor: 3200, dropMinor: 50000 } });
    expect(await s.pendingCount()).toBe(4);
  });
  it("only counts this session", async () => {
    const s = new MemoryStore(); await s.transact((tx) => tx.put("sales", "a", { ...sale("a", 1000, "cash"), sessionId: "someone-else" }));
    expect((await provisionalZ(s, session)).expectedMinor).toBe(30000);
  });
});

describe("drawer movements, closing, clocking", () => {
  it("queues payloads the server accepts", async () => {
    const s = new MemoryStore();
    await recordMove(s, { session, cashierId: session.cashierId, kind: "pay_out", amountMinor: 3200, reason: "courier" }); await recordMove(s, { session, cashierId: session.cashierId, kind: "no_sale", amountMinor: 0 });
    const q = await s.pendingCommands(10); expect(q.map((c) => CashMove.safeParse(c.payload).success)).toEqual([true, true]);
    const closed = await closeRegister(s, { session, cashierId: session.cashierId, countedMinor: 26500, breakdown: { "10000": 2, "5000": 1 } });
    expect(closed).toMatchObject({ status: "closed", provisionalExpectedMinor: 26800, provisionalVarianceMinor: -300 });
    expect((await s.get<LocalSession>("session", "current"))!.status).toBe("closed");
    const last = (await s.pendingCommands(10)).at(-1)!; expect(last.type).toBe("session.close"); expect(SessionClose.safeParse(last.payload).success).toBe(true);
  });
  it("clock in/out is remembered locally and queued", async () => {
    const s = new MemoryStore(); expect(await clockState(s)).toBeUndefined();
    await recordPunch(s, { actorId: session.cashierId, kind: "in" }); expect((await clockState(s))!.kind).toBe("in");
    await recordPunch(s, { actorId: session.cashierId, kind: "out" }); expect((await clockState(s))!.kind).toBe("out"); expect((await s.pendingCommands(5)).map((c) => c.type)).toEqual(["punch.record", "punch.record"]);
  });
});

describe("refunds", () => {
  it("plans pro-rata amounts, the last units take the remainder, and over-asking throws", () => {
    const sl = fromLocal(sale("a", 10000, "card", 3, 909));
    expect(maxRefundable(sl.lines[0]!)).toBe(3);
    expect(planRefund(sl, [{ lineNo: 0, qty: 1, restock: true }])).toMatchObject({ totalMinor: 3333, taxMinor: 303 });
    expect(planRefund(sl, [{ lineNo: 0, qty: 3, restock: true }])).toMatchObject({ totalMinor: 10000, taxMinor: 909 });
    expect(() => planRefund(sl, [{ lineNo: 0, qty: 4, restock: true }])).toThrow(); expect(planRefund(sl, [{ lineNo: 0, qty: 0, restock: true }]).lines).toEqual([]);
  });
  it("completing a refund queues a valid command and advances the local sale, so a second offline refund cannot double-count", async () => {
    const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const s = new MemoryStore(); const sl = sale(SID, 10000, "card", 3, 909); await s.transact((tx) => tx.put("sales", sl.id, sl));
    const r1 = await completeRefund(s, { sale: fromLocal(sl), picks: [{ lineNo: 0, qty: 1, restock: true }], tender: "card", reason: "wrong_size", sessionId: session.id, cashierId: session.cashierId });
    expect(r1.totalMinor).toBe(3333);
    const after = (await s.get<LocalSale>("sales", SID))!; expect(after.lines[0]).toMatchObject({ refundedQty: 1, refundedMinor: 3333, refundedTaxMinor: 303 });
    const r2 = await completeRefund(s, { sale: fromLocal(after), picks: [{ lineNo: 0, qty: 2, restock: false }], tender: "card", reason: "faulty", sessionId: session.id, cashierId: session.cashierId });
    expect(r2.totalMinor).toBe(6667);
    await expect(completeRefund(s, { sale: fromLocal((await s.get<LocalSale>("sales", SID))!), picks: [{ lineNo: 0, qty: 1, restock: true }], tender: "card", reason: "other", sessionId: session.id, cashierId: session.cashierId })).rejects.toThrow();
    const q = await s.pendingCommands(10); expect(q.map((c) => c.type)).toEqual(["refund.create", "refund.create"]); expect(q.every((c) => RefundCreate.safeParse(c.payload).success)).toBe(true);
    await expect(completeRefund(s, { sale: fromLocal(after), picks: [], tender: "cash", reason: "other", sessionId: session.id, cashierId: session.cashierId })).rejects.toThrow();
  });
});

import { describe as d2, expect as e2, it as i2 } from "vitest";
import { describe as describeCmd, exportQueue, queueItems } from "./queue";
d2("queue view and emergency export", () => {
  i2("describes commands in plain language and exports exactly what is unsent, with the receipts", async () => {
    const s = new MemoryStore(); const sl = sale("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 36805, "card", 3); await s.transact((tx) => tx.put("sales", sl.id, sl));
    await s.transact((tx) => tx.enqueue({ type: "sale.create", payload: { saleId: sl.id, receiptNo: "FIT-2-000001", lines: [{ qty: 3 }], totals: { payableMinor: 36805 } }, actorId: session.cashierId, schemaV: 1 }));
    const sent = sale("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 1000, "card", 1); await s.transact((tx) => tx.put("sales", sent.id, sent));          // already acknowledged: stored, but not in the queue
    await s.transact((tx) => tx.enqueue({ type: "refund.create", payload: { refundId: "r1", tender: "cash", totalMinor: 1200, lines: [{}, {}] }, actorId: session.cashierId, schemaV: 1 }));
    await recordMove(s, { session, cashierId: session.cashierId, kind: "pay_out", amountMinor: 3200, reason: "courier" });
    const items = await queueItems(s); e2(items.map((x) => x.label)).toEqual(["Sale", "Refund", "Cash entry"]); e2(items[1]).toMatchObject({ detail: "2 lines · cash", amountMinor: 1200 }); e2(items[0]).toMatchObject({ detail: "FIT-2-000001 · 3 items", amountMinor: 36805 }); e2(items[2]).toMatchObject({ detail: "pay out · courier", amountMinor: 3200 });
    const x = await exportQueue(s, "http://api", new Date("2026-11-04T10:00:00Z")); e2(x).toMatchObject({ format: "shelfline-queue", version: 1, server: "http://api", exportedAt: "2026-11-04T10:00:00.000Z" }); e2(x.commands).toHaveLength(3); e2(x.sales.map((v) => v.id)).toEqual([sl.id]);
    e2(describeCmd({ ...x.commands[0]!, type: "mystery" }).label).toBe("mystery");
  });
});
