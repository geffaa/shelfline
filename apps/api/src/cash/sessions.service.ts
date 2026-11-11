import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { cashMovement, customer, device, payment, product, punch, refund, register, registerSession, sale, saleLine, user, variant } from "../db/schema";
import { zReport } from "./z-report";

@Injectable()
export class SessionsService {
  constructor(@Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService, @Inject(AuditService) private audit: AuditService) {}

  private async load(orgId: string, id: string) {
    const [s] = await this.db.select({ s: registerSession, regCode: register.code }).from(registerSession).innerJoin(register, eq(register.id, registerSession.registerId)).where(and(eq(registerSession.id, id), eq(registerSession.orgId, orgId)));
    if (!s) throw new NotFoundException({ code: "session_not_found" });
    return s;
  }

  async list(orgId: string, locationId: string, localDate: string | undefined) {
    const rows = await this.db.select({ s: registerSession, regCode: register.code, opener: user.name }).from(registerSession).innerJoin(register, eq(register.id, registerSession.registerId)).innerJoin(user, eq(user.id, registerSession.openedBy))
      .where(and(eq(registerSession.orgId, orgId), eq(registerSession.locationId, locationId), localDate ? sql`((${registerSession.openedAt} at time zone (select timezone from shelfline.location where id = ${locationId})) - (select day_cutoff::interval from shelfline.location where id = ${locationId}))::date = ${localDate}::date` : undefined)).orderBy(desc(registerSession.openedAt)).limit(100);
    return Promise.all(rows.map(async (r) => { const z = await zReport(this.db, r.s.id); return { id: r.s.id, register: r.regCode, cashier: r.opener, openedAt: r.s.openedAt, closedAt: r.s.closedAt, status: r.s.status, salesCount: z?.salesCount ?? 0, netSalesMinor: z?.netSalesMinor ?? 0, expectedMinor: z?.expectedMinor ?? 0, varianceMinor: r.s.varianceMinor, flags: r.s.flags, reviewedAt: r.s.reviewedAt }; }));
  }

  async detail(orgId: string, userId: string, id: string) {
    const { s, regCode } = await this.load(orgId, id);
    if (!(await this.authz.can(userId, "cash:read", s.locationId))) throw new ForbiddenException({ code: "forbidden", permission: "cash:read" });
    const z = await zReport(this.db, id);
    const [moves, refunds, punches] = await Promise.all([
      this.db.select({ m: cashMovement, name: user.name }).from(cashMovement).innerJoin(user, eq(user.id, cashMovement.actorId)).where(eq(cashMovement.sessionId, id)),
      this.db.select({ r: refund, name: user.name, receipt: sale.receiptNo }).from(refund).innerJoin(user, eq(user.id, refund.actorId)).innerJoin(sale, eq(sale.id, refund.saleId)).where(eq(refund.sessionId, id)),
      this.db.select({ p: punch, name: user.name }).from(punch).innerJoin(user, eq(user.id, punch.userId)).where(and(eq(punch.locationId, s.locationId), inArray(punch.userId, [s.openedBy, ...(s.closedBy ? [s.closedBy] : [])]), sql`${punch.clientTs} between ${s.openedAt}::timestamptz - interval '6 hours' and coalesce(${s.closedAt}::timestamptz, now()) + interval '2 hours'`)),
    ]);
    type Ev = { at: Date; kind: string; actor: string; amountMinor?: number; reason?: string | null; flags?: string[]; ref?: string };
    const events: Ev[] = [
      ...punches.map((x): Ev => ({ at: x.p.clientTs, kind: x.p.kind === "in" ? "clock_in" : "clock_out", actor: x.name, flags: x.p.status === "needs_review" ? ["needs_review"] : [], reason: x.p.method })),
      { at: s.openedAt, kind: "register_opened", actor: "", amountMinor: s.openingFloatMinor },
      ...moves.map(({ m, name }): Ev => ({ at: m.at, kind: m.kind, actor: name, amountMinor: m.amountMinor, reason: m.reason, flags: m.flags })),
      ...refunds.map(({ r, name, receipt }): Ev => ({ at: r.at, kind: "refund", actor: name, amountMinor: r.totalMinor, reason: r.reason, flags: r.flags, ref: receipt })),
      ...(s.closedAt ? [{ at: s.closedAt, kind: "register_closed", actor: "", amountMinor: s.countedCloseMinor ?? undefined, flags: s.flags } as Ev] : []),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const [op] = await this.db.select({ n: user.name }).from(user).where(eq(user.id, s.openedBy));
    const changedSinceClose = s.status !== "open" && z && s.expectedCloseMinor !== null && z.expectedMinor !== s.expectedCloseMinor;
    return { id: s.id, register: regCode, locationId: s.locationId, status: s.status, openedAt: s.openedAt, openedBy: op?.n ?? null, closedAt: s.closedAt, openingFloatMinor: s.openingFloatMinor, countedMinor: s.countedCloseMinor, expectedAtCloseMinor: s.expectedCloseMinor, varianceMinor: s.varianceMinor, flags: s.flags, reviewedAt: s.reviewedAt, reviewNote: s.reviewNote, z, changedSinceClose: !!changedSinceClose, events };
  }

  async review(orgId: string, userId: string, id: string, note: string, ip: string | null) {
    const { s } = await this.load(orgId, id);
    if (!(await this.authz.can(userId, "cash:approve", s.locationId))) throw new ForbiddenException({ code: "forbidden", permission: "cash:approve" });
    await this.db.update(registerSession).set({ reviewedBy: userId, reviewedAt: new Date(), reviewNote: note }).where(eq(registerSession.id, id));
    await this.audit.record({ orgId, actorId: userId, action: "session.review", subjectType: "register_session", subjectId: id, after: { note, varianceMinor: s.varianceMinor }, ip });
  }

  // ---- for the till
  async posSession(orgId: string, deviceId: string | undefined, id: string) {
    const [d] = deviceId ? await this.db.select().from(device).where(eq(device.id, deviceId)) : [];
    const { s } = await this.load(orgId, id);
    if (!d || s.registerId !== d.registerId) throw new ForbiddenException({ code: "forbidden" });
    return { id: s.id, status: s.status, expectedMinor: s.expectedCloseMinor, countedMinor: s.countedCloseMinor, varianceMinor: s.varianceMinor, flags: s.flags, z: await zReport(this.db, id) };
  }

  /** Sales at this device's location, refundable view. `receipt` matches a receipt number exactly (any register); empty returns the latest. */
  async posSales(orgId: string, deviceId: string | undefined, receipt: string | undefined) {
    const [d] = deviceId ? await this.db.select().from(device).where(eq(device.id, deviceId)) : [];
    if (!d) throw new ForbiddenException({ code: "device_required" });
    const rows = await this.db.select({ s: sale, cashier: user.name, customer: customer.name }).from(sale).innerJoin(user, eq(user.id, sale.cashierId)).leftJoin(customer, eq(customer.id, sale.customerId))
      .where(and(eq(sale.orgId, orgId), eq(sale.locationId, d.locationId), receipt ? sql`lower(${sale.receiptNo}) = lower(${receipt.trim()})` : undefined)).orderBy(desc(sale.effectiveAt)).limit(receipt ? 5 : 25);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.s.id);
    const [lines, pays] = await Promise.all([
      this.db.select({ l: saleLine, title: product.title, opts: variant.options }).from(saleLine).innerJoin(variant, eq(variant.id, saleLine.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(inArray(saleLine.saleId, ids)).orderBy(asc(saleLine.lineNo)),
      this.db.select().from(payment).where(inArray(payment.saleId, ids)).orderBy(asc(payment.id)),
    ]);
    return rows.map((r) => ({
      id: r.s.id, receiptNo: r.s.receiptNo, at: r.s.effectiveAt, cashierName: r.cashier, customerName: r.customer, totalMinor: r.s.totalMinor, status: r.s.status, sessionId: r.s.sessionId,
      lines: lines.filter((x) => x.l.saleId === r.s.id).map((x) => ({ lineNo: x.l.lineNo, variantId: x.l.variantId, title: x.title, optionsLabel: Object.values((x.opts ?? {}) as Record<string, string>).join(" · "), qty: x.l.qty, refundedQty: x.l.refundedQty, totalMinor: x.l.totalMinor, refundedMinor: x.l.refundedMinor, taxMinor: x.l.taxMinor, refundedTaxMinor: x.l.refundedTaxMinor })),
      payments: pays.filter((p) => p.saleId === r.s.id).map((p) => ({ tender: p.tender, amountMinor: p.amountMinor })),
    }));
  }
}
