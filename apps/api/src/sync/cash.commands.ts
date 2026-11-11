import { BadRequestException, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { CashMove, PunchRecord, RefundCreate, SessionClose } from "@shelfline/contracts";
import { refundAmount } from "@shelfline/pricing";
import { AuthzService } from "../auth/authz.service";
import { TokenService } from "../auth/tokens";
import { zReport } from "../cash/z-report";
import { businessDate } from "../common/business-day";
import { cashMovement, location, punch, refund, refundLine, registerSession, sale, saleLine, variant } from "../db/schema";
import { addEntry } from "../gift/gift.service";
import { LoyaltyService } from "../marketing/loyalty.service";
import { LedgerService } from "../inventory/ledger.service";
import { CommandRegistry, type CommandContext, type HandlerOutput } from "./commands";

type Exc = NonNullable<HandlerOutput["exceptions"]>[number];

/** Cash drawer, refunds, closing the register and clocking in/out. Same principle as selling: money and goods already moved, so record and flag. */
@Injectable()
export class CashCommands implements OnModuleInit {
  constructor(@Inject(CommandRegistry) private reg: CommandRegistry, @Inject(LedgerService) private ledger: LedgerService, @Inject(TokenService) private tokens: TokenService, @Inject(AuthzService) private authz: AuthzService, @Inject(LoyaltyService) private loyalty: LoyaltyService) {}
  onModuleInit() {
    this.reg.register({ type: "cash.move", schema: CashMove, handle: (c, p) => this.cashMove(c, p) });
    this.reg.register({ type: "session.close", schema: SessionClose, handle: (c, p) => this.closeSession(c, p) });
    this.reg.register({ type: "refund.create", schema: RefundCreate, handle: (c, p) => this.createRefund(c, p) });
    this.reg.register({ type: "punch.record", schema: PunchRecord, handle: (c, p) => this.punch(c, p) });
  }

  private tracker() {
    const flags: string[] = []; const exceptions: Exc[] = [];
    return { flags, exceptions, flag: (kind: string, refType: string, refId: string, detail?: unknown) => { flags.push(kind); exceptions.push({ kind, refType, refId, detail }); } };
  }

  private async cashMove(ctx: CommandContext, p: CashMove): Promise<HandlerOutput> {
    const { tx, device, at } = ctx; if (!device.registerId) throw new BadRequestException({ code: "device_has_no_register" });
    if (p.kind === "no_sale" ? p.amountMinor !== 0 : p.amountMinor <= 0) throw new BadRequestException({ code: "bad_amount", kind: p.kind });
    const t = this.tracker();
    const [ses] = await tx.select().from(registerSession).where(eq(registerSession.id, p.sessionId));
    if (!ses) t.flag("no_session", "cash_movement", p.movementId, { sessionId: p.sessionId }); else if (ses.status !== "open") t.flag("late_movement", "cash_movement", p.movementId, { sessionStatus: ses.status });
    if (p.kind === "no_sale" && !p.reason) t.flag("no_sale_no_reason", "cash_movement", p.movementId);
    if (p.kind === "pay_out" && !p.reason) t.flag("pay_out_no_reason", "cash_movement", p.movementId);
    const [loc] = await tx.select().from(location).where(eq(location.id, device.locationId));
    await tx.insert(cashMovement).values({ id: p.movementId, orgId: ctx.orgId, sessionId: ses?.id ?? null, registerId: device.registerId, locationId: device.locationId, kind: p.kind, amountMinor: p.amountMinor, reason: p.reason ?? null, actorId: ctx.actorId, at, localDate: businessDate(at, loc!.timezone, loc!.dayCutoff), flags: t.flags, deviceId: device.id, commandId: ctx.commandId });
    return { result: { movementId: p.movementId }, flags: t.flags, exceptions: t.exceptions };
  }

  private async closeSession(ctx: CommandContext, p: SessionClose): Promise<HandlerOutput> {
    const { tx, device, at } = ctx;
    const [ses] = await tx.select().from(registerSession).where(eq(registerSession.id, p.sessionId)).for("update");
    if (!ses) throw new BadRequestException({ code: "unknown_session" });
    if (ses.registerId !== device.registerId) throw new BadRequestException({ code: "wrong_register" });
    if (ses.status !== "open") return { result: { sessionId: ses.id, status: ses.status, expectedMinor: ses.expectedCloseMinor, varianceMinor: ses.varianceMinor, existing: true } };
    const z = (await zReport(tx, ses.id))!;
    const variance = p.countedMinor - z.expectedMinor;
    const [loc] = await tx.select().from(location).where(eq(location.id, device.locationId));
    const t = this.tracker(); const sessionFlags: string[] = [];
    if (Math.abs(variance) > loc!.cashVarianceLimitMinor) {
      const approver = p.approvalToken ? await this.tokens.verifyApproval(p.approvalToken, { orgId: ctx.orgId, deviceId: device.id, locationId: device.locationId, kind: "variance" }) : null;
      sessionFlags.push(approver ? "variance_approved" : "variance_over_limit");
      if (!approver) t.flag("variance_over_limit", "register_session", ses.id, { varianceMinor: variance, limitMinor: loc!.cashVarianceLimitMinor, expectedMinor: z.expectedMinor, countedMinor: p.countedMinor });
      else await tx.update(registerSession).set({ reviewedBy: approver, reviewedAt: at }).where(eq(registerSession.id, ses.id));
    }
    await tx.update(registerSession).set({ status: "closed", closedBy: ctx.actorId, closedAt: at, countedCloseMinor: p.countedMinor, expectedCloseMinor: z.expectedMinor, varianceMinor: variance, countBreakdown: (p.countBreakdown ?? null) as never, flags: sessionFlags }).where(eq(registerSession.id, ses.id));
    return { result: { sessionId: ses.id, status: "closed", expectedMinor: z.expectedMinor, varianceMinor: variance }, flags: t.flags, exceptions: t.exceptions };
  }

  private async createRefund(ctx: CommandContext, p: RefundCreate): Promise<HandlerOutput> {
    const { tx, device, at, orgId } = ctx; if (!device.registerId) throw new BadRequestException({ code: "device_has_no_register" });
    const [s] = await tx.select().from(sale).where(and(eq(sale.id, p.saleId), eq(sale.orgId, orgId)));
    if (!s) throw new BadRequestException({ code: "unknown_sale" });
    const lines = await tx.select().from(saleLine).where(eq(saleLine.saleId, s.id)).for("update");
    const byNo = new Map(lines.map((l) => [l.lineNo, l]));
    const t = this.tracker();
    let sumAmount = 0, sumTax = 0; const stored: { lineNo: number; l: (typeof lines)[number]; qty: number; amount: number; tax: number; restock: boolean }[] = [];
    for (const [i, rl] of p.lines.entries()) {
      const l = byNo.get(rl.saleLineNo); if (!l) throw new BadRequestException({ code: "unknown_sale_line", saleLineNo: rl.saleLineNo });
      const remaining = l.qty - l.refundedQty;
      if (rl.qty > remaining) t.flag("over_refund", "refund", p.refundId, { saleLineNo: l.lineNo, requested: rl.qty, remaining });
      const calc = refundAmount({ qty: l.qty, refundedQty: l.refundedQty, totalMinor: l.totalMinor, refundedMinor: l.refundedMinor, taxMinor: l.taxMinor, refundedTaxMinor: l.refundedTaxMinor }, rl.qty);
      if (calc.amountMinor !== rl.amountMinor || calc.taxMinor !== rl.taxMinor) t.flag("refund_amount_mismatch", "refund", p.refundId, { saleLineNo: l.lineNo, client: { amountMinor: rl.amountMinor, taxMinor: rl.taxMinor }, server: calc });
      sumAmount += rl.amountMinor; sumTax += rl.taxMinor; stored.push({ lineNo: i, l, qty: rl.qty, amount: rl.amountMinor, tax: rl.taxMinor, restock: rl.restock });
    }
    if (sumAmount !== p.totalMinor) t.flag("refund_total_mismatch", "refund", p.refundId, { lines: sumAmount, total: p.totalMinor });

    const [loc] = await tx.select().from(location).where(eq(location.id, device.locationId));
    let approvedBy: string | null = null;
    if (p.totalMinor > loc!.cashierRefundLimitMinor && !(await this.authz.can(ctx.actorId, "cash:approve", device.locationId, tx))) {
      approvedBy = p.approvalToken ? await this.tokens.verifyApproval(p.approvalToken, { orgId, deviceId: device.id, locationId: device.locationId, kind: "refund" }) : null;
      if (!approvedBy) t.flag("refund_unapproved", "refund", p.refundId, { totalMinor: p.totalMinor, limitMinor: loc!.cashierRefundLimitMinor });
    }
    const [ses] = await tx.select().from(registerSession).where(eq(registerSession.id, p.sessionId));
    if (!ses) t.flag("no_session", "refund", p.refundId, { sessionId: p.sessionId }); else if (ses.status !== "open") t.flag("late_refund", "refund", p.refundId, { sessionStatus: ses.status });

    await tx.insert(refund).values({ id: p.refundId, orgId, saleId: s.id, sessionId: ses?.id ?? null, registerId: device.registerId, locationId: device.locationId, tender: p.tender, reason: p.reason, totalMinor: p.totalMinor, taxMinor: sumTax, approvedBy, actorId: ctx.actorId, at, localDate: businessDate(at, loc!.timezone, loc!.dayCutoff), flags: [...new Set(t.flags)], deviceId: device.id, commandId: ctx.commandId });
    await tx.insert(refundLine).values(stored.map((x) => ({ refundId: p.refundId, lineNo: x.lineNo, saleLineNo: x.l.lineNo, variantId: x.l.variantId, qty: x.qty, amountMinor: x.amount, taxMinor: x.tax, restock: x.restock })));
    for (const x of stored) await tx.update(saleLine).set({ refundedQty: sql`${saleLine.refundedQty} + ${x.qty}`, refundedMinor: sql`${saleLine.refundedMinor} + ${x.amount}`, refundedTaxMinor: sql`${saleLine.refundedTaxMinor} + ${x.tax}` }).where(and(eq(saleLine.saleId, s.id), eq(saleLine.lineNo, x.l.lineNo)));
    const after = await tx.select({ qty: saleLine.qty, r: saleLine.refundedQty }).from(saleLine).where(eq(saleLine.saleId, s.id));
    const fully = after.every((l) => l.r >= l.qty);
    await tx.update(sale).set({ status: fully ? "refunded" : "partially_refunded" }).where(eq(sale.id, s.id));
    // loyalty: the points this sale earned are taken back in proportion to what was returned
    if (s.customerId) { const lines = await tx.select({ t: saleLine.totalMinor, x: saleLine.taxMinor }).from(saleLine).where(eq(saleLine.saleId, s.id)); await this.loyalty.clawbackIn(tx, orgId, s.customerId, s.id, p.refundId, { refundNetMinor: stored.reduce((a, x) => a + x.amount - x.tax, 0), saleNetMinor: lines.reduce((a, l) => a + l.t - l.x, 0), fullyRefunded: fully }); }

    // Returned stock goes back on this shelf (which may be a different store from where it was sold). Damaged items (restock = false) do not.
    const tracked = new Set((await tx.select({ id: variant.id, t: variant.trackStock }).from(variant).where(eq(variant.orgId, orgId))).filter((v) => v.t).map((v) => v.id));
    const moves = stored.filter((x) => x.restock && tracked.has(x.l.variantId)).map((x) => ({ variantId: x.l.variantId, locationId: device.locationId, qtyDelta: x.qty, kind: "refund_return" as const, sourceType: "refund", sourceId: p.refundId, lineNo: x.lineNo, at, deviceId: device.id }));
    if (moves.length) await this.ledger.appendIn(tx, orgId, ctx.actorId, moves);
    // refund to store credit: the money stays with us, in the customer's account (needs a customer on the sale)
    if (p.tender === "store_credit") {
      if (!s.customerId) t.flag("refund_credit_no_customer", "refund", p.refundId, { totalMinor: p.totalMinor });
      else await addEntry(tx, { orgId, type: "store_credit", accountId: s.customerId, delta: p.totalMinor, kind: "refund_credit", sourceType: "refund", sourceId: p.refundId, locationId: device.locationId, deviceId: device.id, actorId: ctx.actorId, at });
    }
    return { result: { refundId: p.refundId, totalMinor: p.totalMinor }, flags: [...new Set(t.flags)], exceptions: t.exceptions };
  }

  private async punch(ctx: CommandContext, p: PunchRecord): Promise<HandlerOutput> {
    const { tx, device, at } = ctx;
    const [last] = await tx.select().from(punch).where(and(eq(punch.userId, ctx.actorId), eq(punch.locationId, device.locationId))).orderBy(desc(punch.clientTs), desc(punch.receivedAt)).limit(1);
    const repeat = !!last && last.kind === p.kind;
    await tx.insert(punch).values({ id: p.punchId, orgId: ctx.orgId, userId: ctx.actorId, locationId: device.locationId, kind: p.kind, method: p.method, sourceDeviceId: device.id, clientTs: at, clockSkewMs: device.clockSkewMs, status: repeat ? "needs_review" : "accepted" });
    return repeat ? { result: { punchId: p.punchId, status: "needs_review" }, flags: ["punch_repeat"], exceptions: [{ kind: "punch_repeat", refType: "punch", refId: p.punchId, detail: { kind: p.kind } }] } : { result: { punchId: p.punchId, status: "accepted" } };
  }
}
