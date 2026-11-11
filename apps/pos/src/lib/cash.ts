import { SCHEMA_V, type CASH_KINDS } from "@shelfline/contracts";
import { uuidv7, type LocalStore } from "@shelfline/sync-client";
import type { LocalSale, LocalSession } from "./sales";

export type CashKind = (typeof CASH_KINDS)[number];
export interface LocalMove { id: string; sessionId: string; kind: CashKind; amountMinor: number; reason?: string; at: string }
export interface ProvisionalZ {
  openingFloatMinor: number; expectedMinor: number; salesCount: number; grossSalesMinor: number; refundsMinor: number; netSalesMinor: number; gstMinor: number; noSaleCount: number;
  cash: { salesMinor: number; refundsMinor: number; payInMinor: number; payOutMinor: number; dropMinor: number; floatAddMinor: number }; tenders: { cashMinor: number; cardMinor: number; otherMinor: number };
}
export interface LocalRefund { id: string; saleId: string; receiptNo: string; sessionId: string; tender: "cash" | "card" | "other" | "store_credit"; totalMinor: number; taxMinor: number; reason: string; at: string; lines: { title: string; qty: number; amountMinor: number }[] }

export async function recordMove(store: LocalStore, a: { session: LocalSession; cashierId: string; kind: CashKind; amountMinor: number; reason?: string; now?: Date }): Promise<LocalMove> {
  const now = a.now ?? new Date(); const m: LocalMove = { id: uuidv7(now.getTime()), sessionId: a.session.id, kind: a.kind, amountMinor: a.amountMinor, ...(a.reason ? { reason: a.reason } : {}), at: now.toISOString() };
  await store.transact(async (tx) => {
    await tx.put("cash", m.id, m);
    await tx.enqueue({ type: "cash.move", payload: { movementId: m.id, sessionId: m.sessionId, kind: m.kind, amountMinor: m.amountMinor, ...(m.reason ? { reason: m.reason } : {}) }, actorId: a.cashierId, clientTs: now.toISOString(), schemaV: SCHEMA_V });
  });
  return m;
}

/**
 * The same arithmetic as the server's Z report (apps/api/src/cash/z-report.ts), run on what this till knows. It is provisional: the server's
 * figure at close is final, and the two agree unless another till put money into this register's session.
 */
export async function provisionalZ(store: LocalStore, session: LocalSession): Promise<ProvisionalZ> {
  const sales = (await store.list<LocalSale>("sales")).map((x) => x.value).filter((s) => s.sessionId === session.id);
  const refunds = (await store.list<LocalRefund>("refunds")).map((x) => x.value).filter((r) => r.sessionId === session.id);
  const moves = (await store.list<LocalMove>("cash")).map((x) => x.value).filter((m) => m.sessionId === session.id);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const tender = (t: string) => sum(sales.flatMap((s) => s.payments.filter((p) => p.tender === t).map((p) => p.amountMinor)));
  const mv = (k: CashKind) => sum(moves.filter((m) => m.kind === k).map((m) => m.amountMinor));
  const cashSales = tender("cash"), cashRefunds = sum(refunds.filter((r) => r.tender === "cash").map((r) => r.totalMinor));
  const gross = cashSales + tender("card") + tender("other"), refundsTotal = sum(refunds.map((r) => r.totalMinor));
  return {
    openingFloatMinor: session.openingFloatMinor, expectedMinor: session.openingFloatMinor + cashSales - cashRefunds + mv("pay_in") + mv("float_add") - mv("pay_out") - mv("drop"),
    salesCount: sales.length, grossSalesMinor: gross, refundsMinor: refundsTotal, netSalesMinor: gross - refundsTotal, gstMinor: sum(sales.map((s) => s.totals.taxMinor)) - sum(refunds.map((r) => r.taxMinor)), noSaleCount: moves.filter((m) => m.kind === "no_sale").length,
    cash: { salesMinor: cashSales, refundsMinor: cashRefunds, payInMinor: mv("pay_in"), payOutMinor: mv("pay_out"), dropMinor: mv("drop"), floatAddMinor: mv("float_add") }, tenders: { cashMinor: cashSales, cardMinor: tender("card"), otherMinor: tender("other") },
  };
}

/** Queue the close and mark the local session closed, together. The till keeps its provisional figures to show until the server's final ones arrive. */
export async function closeRegister(store: LocalStore, a: { session: LocalSession; cashierId: string; countedMinor: number; breakdown: Record<string, number>; approvalToken?: string; now?: Date }): Promise<LocalSession> {
  const now = a.now ?? new Date(); const z = await provisionalZ(store, a.session);
  const closed: LocalSession = { ...a.session, status: "closed", closedAt: now.toISOString(), countedMinor: a.countedMinor, provisionalExpectedMinor: z.expectedMinor, provisionalVarianceMinor: a.countedMinor - z.expectedMinor };
  await store.transact(async (tx) => {
    await tx.put("session", "current", closed);
    await tx.enqueue({ type: "session.close", payload: { sessionId: a.session.id, countedMinor: a.countedMinor, ...(Object.keys(a.breakdown).length ? { countBreakdown: a.breakdown } : {}), ...(a.approvalToken ? { approvalToken: a.approvalToken } : {}) }, actorId: a.cashierId, clientTs: now.toISOString(), schemaV: SCHEMA_V });
  });
  return closed;
}

export interface Punch { kind: "in" | "out"; at: string }
export const clockState = (store: LocalStore) => store.get<Punch>("punch", "last");
export async function recordPunch(store: LocalStore, a: { actorId: string; kind: "in" | "out"; now?: Date }): Promise<Punch> {
  const now = a.now ?? new Date(); const p: Punch = { kind: a.kind, at: now.toISOString() };
  await store.transact(async (tx) => { await tx.put("punch", "last", p); await tx.enqueue({ type: "punch.record", payload: { punchId: uuidv7(now.getTime()), kind: a.kind, method: "pin" }, actorId: a.actorId, clientTs: now.toISOString(), schemaV: SCHEMA_V }); });
  return p;
}
