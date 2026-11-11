import { BadRequestException, Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { CustomerCreate, SaleCreate, SessionOpen } from "@shelfline/contracts";
import { applyPromotions, priceCart, resolvePrice, resolveTaxRule, type RateRow } from "@shelfline/pricing";
import { pricingFor } from "../pricing/scope";
import { GiftService } from "../gift/gift.service";
import { AuthzService } from "../auth/authz.service";
import { TokenService } from "../auth/tokens";
import { businessDate } from "../common/business-day";
import { DB, type Db } from "../db/db.module";
import { cardPayment, customer, location, payment, product, registerSession, sale, saleLine, stockBalance, taxRate, variant } from "../db/schema";
import { LedgerService } from "../inventory/ledger.service";
import { logConsent } from "../marketing/consent";
import { LoyaltyService } from "../marketing/loyalty.service";
import { OnlineService } from "../online/online.service";
import { CommandRegistry, type CommandContext, type HandlerOutput } from "./commands";

type Exc = NonNullable<HandlerOutput["exceptions"]>[number];

/**
 * Commands a till sends while selling. Principle (TECH-SPEC 5.1): a sale is a physical fact. The server rejects only what it cannot
 * record at all (an unknown variant); everything else is accepted and flagged so a manager sees it as an exception.
 */
@Injectable()
export class SellingCommands implements OnModuleInit {
  constructor(@Inject(GiftService) private gift: GiftService, @Inject(CommandRegistry) private reg: CommandRegistry, @Inject(LedgerService) private ledger: LedgerService, @Inject(TokenService) private tokens: TokenService, @Inject(AuthzService) private authz: AuthzService, @Inject(DB) private db: Db, @Inject(OnlineService) private online: OnlineService, @Inject(LoyaltyService) private loyalty: LoyaltyService) {}

  onModuleInit() {
    this.reg.register({ type: "session.open", schema: SessionOpen, handle: (ctx, p) => this.openSession(ctx, p) });
    this.reg.register({ type: "customer.create", schema: CustomerCreate, handle: (ctx, p) => this.createCustomer(ctx, p) });
    this.reg.register({ type: "sale.create", schema: SaleCreate, handle: (ctx, p) => this.createSale(ctx, p) });
  }

  private async openSession(ctx: CommandContext, p: SessionOpen): Promise<HandlerOutput> {
    const { tx, device, at } = ctx;
    if (!device.registerId) throw new BadRequestException({ code: "device_has_no_register" });
    const open = await tx.select().from(registerSession).where(and(eq(registerSession.registerId, device.registerId), eq(registerSession.status, "open"))).for("update");
    if (open.some((s) => s.id === p.sessionId)) return { result: { sessionId: p.sessionId, existing: true } };
    const exceptions: Exc[] = [];
    for (const old of open) {
      await tx.update(registerSession).set({ status: "force_closed", closedAt: at, closedBy: ctx.actorId, flags: ["needs_review"] }).where(eq(registerSession.id, old.id));
      exceptions.push({ kind: "session_force_closed", refType: "register_session", refId: old.id, detail: { replacedBy: p.sessionId, registerId: device.registerId } });
    }
    await tx.insert(registerSession).values({ id: p.sessionId, orgId: ctx.orgId, registerId: device.registerId, locationId: device.locationId, openedBy: ctx.actorId, openedAt: at, openingFloatMinor: p.openingFloatMinor, countBreakdown: (p.countBreakdown ?? null) as never });
    return { result: { sessionId: p.sessionId }, flags: exceptions.length ? ["session_force_closed"] : [], exceptions };
  }

  private async createCustomer(ctx: CommandContext, p: CustomerCreate): Promise<HandlerOutput> {
    const { tx } = ctx;
    const [byId] = await tx.select({ id: customer.id }).from(customer).where(eq(customer.id, p.customerId));
    if (byId) return { result: { customerId: p.customerId, existing: true } };
    const exceptions: Exc[] = []; let email: string | null = p.email ?? null; let notes: string | null = null;
    if (email) {
      const [dupe] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.orgId, ctx.orgId), sql`lower(${customer.email}) = ${email.toLowerCase()}`));
      if (dupe) { exceptions.push({ kind: "merge_candidate", refType: "customer", refId: p.customerId, detail: { email, existingCustomerId: dupe.id } }); notes = `possible duplicate of ${dupe.id} (${email})`; email = null; }
    }
    await tx.insert(customer).values({ id: p.customerId, orgId: ctx.orgId, name: p.name, email, phone: p.phone ?? null, marketingConsent: (p.marketingConsent ?? {}) as never, notes });
    await logConsent(tx, { orgId: ctx.orgId, customerId: p.customerId, before: undefined, after: p.marketingConsent, source: "pos", actorId: ctx.actorId });
    return { result: { customerId: p.customerId }, flags: exceptions.map((e) => e.kind), exceptions };
  }

  private async createSale(ctx: CommandContext, p: SaleCreate): Promise<HandlerOutput> {
    const { tx, device, at, orgId } = ctx;
    if (!device.registerId) throw new BadRequestException({ code: "device_has_no_register" });
    const flags: string[] = []; const exceptions: Exc[] = [];
    const flag = (kind: string, detail?: unknown) => { flags.push(kind); exceptions.push({ kind, refType: "sale", refId: p.saleId, detail }); };

    const [loc] = await tx.select().from(location).where(eq(location.id, device.locationId));
    const localDate = businessDate(at, loc!.timezone, loc!.dayCutoff);
    const variantIds = [...new Set(p.lines.map((l) => l.variantId))];
    const vrows = await tx.select({ v: variant, taxClassId: product.taxClassId }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.orgId, orgId), inArray(variant.id, variantIds)));
    const byId = new Map(vrows.map((r) => [r.v.id, r]));
    const unknown = variantIds.filter((id) => !byId.has(id));
    if (unknown.length) throw new BadRequestException({ code: "unknown_variant", variantIds: unknown });

    const classIds = [...new Set(vrows.map((r) => r.taxClassId))];
    const rateRows = await tx.select().from(taxRate).where(inArray(taxRate.taxClassId, classIds));
    const ratesFor = (cid: string): RateRow[] => rateRows.filter((r) => r.taxClassId === cid).map((r) => ({ region: r.region, rateBp: r.rateBp, taxInclusive: r.taxInclusive, validFrom: r.validFrom, validTo: r.validTo }));
    let noRate = false;
    const rules = p.lines.map((l) => { const rule = resolveTaxRule(ratesFor(byId.get(l.variantId)!.taxClassId), loc!.taxRegion, localDate); if (!rule) noRate = true; return rule ?? { rateBp: 0, inclusive: true }; });
    if (noRate) flag("no_tax_rate", { localDate, taxRegion: loc!.taxRegion });

    // ---- price books and promotions: the same two functions the till ran offline, on the books as they are now. A difference is flagged, never refused (the customer already paid the till's price).
    const px = await pricingFor(tx, orgId, device.locationId);
    const seen = p.lines.map((l) => resolvePrice(l.variantId, byId.get(l.variantId)!.v.basePriceMinor, localDate, px.books));
    const promoServer = applyPromotions(p.lines.map((l) => ({ variantId: l.variantId, unitPriceMinor: l.unitPriceMinor, qty: l.qty })), px.promos, localDate);
    const wrongPrice = p.lines.map((l, i) => ({ i, sent: l.unitPriceMinor, server: seen[i]!.unitPriceMinor })).filter((x) => x.sent !== x.server && (seen[x.i]!.priceBookId !== null || !!p.lines[x.i]!.priceBookId));   // only prices a book is involved in; plain catalogue prices were never policed
    if (wrongPrice.length) flag("price_book_mismatch", { lines: wrongPrice, devicePricingVersion: p.pricingVersion ?? null, serverPricingVersion: px.version });
    const wrongPromo = p.lines.map((l, i) => ({ i, sent: l.promoDiscountMinor ?? 0, server: promoServer[i]!.discountMinor })).filter((x) => x.sent !== x.server);
    if (wrongPromo.length) flag("promo_mismatch", { lines: wrongPromo, devicePricingVersion: p.pricingVersion ?? null, serverPricingVersion: px.version });

    // ---- re-price with the same code the till ran, from the till's own unit prices and discounts
    const allCash = p.payments.every((x) => x.tender === "cash");
    const server = priceCart(p.lines.map((l, i) => ({ unitPriceMinor: l.unitPriceMinor, qty: l.qty, discountMinor: Math.min(l.discountMinor, l.unitPriceMinor * l.qty), tax: rules[i]! })), { cashRoundingStep: allCash ? p.cashRoundingStep : null });
    const client = p.totals;
    const diff = { subtotalMinor: [client.subtotalMinor, server.subtotalMinor], discountMinor: [client.discountMinor, server.discountMinor], taxMinor: [client.taxMinor, server.taxMinor], totalMinor: [client.totalMinor, server.totalMinor], roundingMinor: [client.roundingMinor, server.cashRoundingMinor], payableMinor: [client.payableMinor, server.payableMinor] } as Record<string, [number, number]>;
    const mismatched = Object.entries(diff).filter(([, [a, b]]) => a !== b);
    if (mismatched.length || p.lines.some((l) => l.discountMinor > l.unitPriceMinor * l.qty)) flag("price_mismatch", { client: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v[0]])), server: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v[1]])) });

    // ---- discount authority: over the cashier's limit needs a manager approval token, unless the cashier may approve it themself
    const canApprove = await this.authz.can(ctx.actorId, "sale:approve_discount", device.locationId, tx);
    const approvers = new Map<number, string>();
    if (!canApprove) {
      let unapproved = false;
      for (const [i, l] of p.lines.entries()) {
        const limit = Math.floor((l.unitPriceMinor * l.qty * loc!.cashierDiscountLimitBp) / 10000);
        if (l.discountMinor - Math.min(l.promoDiscountMinor ?? 0, l.discountMinor) <= limit) continue;          // only the cashier's own discount needs authority; a promotion is the company's
        const who = l.approvalToken ? await this.tokens.verifyApproval(l.approvalToken, { orgId, deviceId: device.id, locationId: device.locationId, kind: "discount" }) : null;
        if (who) approvers.set(i, who); else unapproved = true;
      }
      if (unapproved) flag("discount_unapproved");
    }

    // ---- payments
    const applied = p.payments.reduce((a, x) => a + x.amountMinor, 0);
    if (applied !== client.payableMinor) flag("payment_mismatch", { applied, payable: client.payableMinor });
    // gift cards and store credit are spent here; the card's code is never kept on the payment, only "Card …1234"
    const spent = p.payments.some((x) => x.tender === "gift_card" || x.tender === "store_credit");
    const giftRefs = spent ? await this.gift.redeemIn(tx, { orgId, saleId: p.saleId, locationId: device.locationId, deviceId: device.id, actorId: ctx.actorId, at, customerId: p.customerId }, p.payments, flag) : new Map<number, string>();
    const payRows = p.payments.map((x, i) => ({ tender: x.tender, amountMinor: x.amountMinor, changeMinor: x.tender === "cash" && x.tenderedMinor !== undefined ? Math.max(0, x.tenderedMinor - x.amountMinor) : 0, reference: x.tender === "gift_card" || x.tender === "store_credit" ? giftRefs.get(i) ?? null : x.reference ?? null }));
    const changeMinor = payRows.reduce((a, x) => a + x.changeMinor, 0);
    const tenderedMinor = applied + changeMinor;

    // ---- session and customer: a sale that cannot be attached is still a sale
    const [ses] = await tx.select().from(registerSession).where(eq(registerSession.id, p.sessionId));
    let sessionId: string | null = ses?.id ?? null;
    if (!ses) flag("no_session", { sessionId: p.sessionId }); else if (ses.status !== "open") flag("late_sale", { sessionId: ses.id, sessionStatus: ses.status });
    else if (ses.registerId !== device.registerId) flag("session_register_mismatch", { sessionId: ses.id });
    let customerId = p.customerId;
    if (customerId) { const [c] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))); if (!c) { flag("unknown_customer", { customerId }); customerId = null; } }

    // ---- insert the sale (a reused receipt number is kept and flagged, never dropped)
    let receiptNo = p.receiptNo;
    const [taken] = await tx.select({ id: sale.id }).from(sale).where(and(eq(sale.registerId, device.registerId), eq(sale.receiptNo, receiptNo)));
    if (taken) { receiptNo = `${p.receiptNo}~${p.saleId.slice(0, 8)}`; flag("receipt_no_reused", { original: p.receiptNo, stored: receiptNo }); }

    const avg = new Map((await tx.select({ id: stockBalance.variantId, avg: stockBalance.avgCostMinor }).from(stockBalance).where(and(eq(stockBalance.locationId, device.locationId), inArray(stockBalance.variantId, variantIds)))).map((r) => [r.id, r.avg]));
    await tx.insert(sale).values({
      id: p.saleId, orgId, receiptNo, sessionId, registerId: device.registerId, locationId: device.locationId, cashierId: ctx.actorId, customerId,
      subtotalMinor: client.subtotalMinor, discountMinor: client.discountMinor, taxMinor: client.taxMinor, totalMinor: client.totalMinor, roundingMinor: client.roundingMinor, payableMinor: client.payableMinor,
      tenderedMinor, changeMinor, priceSnapshot: { catalogVersion: p.catalogVersion ?? null, pricingVersion: p.pricingVersion ?? null, serverPricingVersion: px.version, serverTotals: { totalMinor: server.totalMinor, taxMinor: server.taxMinor } } as never,
      clientTs: new Date(ctx.at), effectiveAt: at, localDate, flags: [...new Set(flags)], deviceId: device.id, commandId: ctx.commandId,
    });
    await tx.insert(saleLine).values(p.lines.map((l, i) => ({
      saleId: p.saleId, lineNo: i, variantId: l.variantId, qty: l.qty, unitPriceMinor: l.unitPriceMinor, discountMinor: l.discountMinor, discountReason: l.discountReason ?? null,
      approvedBy: approvers.get(i) ?? null, priceBookId: l.priceBookId ?? null, promoDiscountMinor: l.promoDiscountMinor ?? 0, promotionIds: l.promotionIds ?? [], taxRateBp: rules[i]!.rateBp, taxInclusive: rules[i]!.inclusive, taxMinor: server.lines[i]!.taxMinor, totalMinor: server.lines[i]!.totalMinor,
      unitCostMinor: avg.get(l.variantId) ?? null, attributedTo: ctx.actorId,
    })));
    await tx.insert(payment).values(payRows.map((x) => ({ saleId: p.saleId, ...x })));
    // a card tender taken on the card terminal carries "cp:<id>": tie it to this sale if it really was approved for this amount at this store, otherwise say so
    for (const x of payRows) {
      if (x.tender !== "card" || !x.reference) continue; const m = /^cp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(x.reference); if (!m) continue;
      const [cp] = await tx.select().from(cardPayment).where(and(eq(cardPayment.id, m[1]!), eq(cardPayment.orgId, orgId)));
      if (!cp || cp.status !== "succeeded" || cp.amountMinor !== x.amountMinor || cp.locationId !== device.locationId || (cp.saleId && cp.saleId !== p.saleId)) flag("card_unverified", { reference: x.reference, found: !!cp, status: cp?.status ?? null, amountMinor: x.amountMinor, approvedMinor: cp?.amountMinor ?? null });
      else if (!cp.saleId) await tx.update(cardPayment).set({ saleId: p.saleId }).where(eq(cardPayment.id, cp.id));
    }

    // ---- loyalty: points for what was bought, without GST, at the customer's tier, in this same transaction
    if (customerId) await this.loyalty.earnIn(tx, orgId, customerId, p.saleId, server.lines.reduce((a, l) => a + l.totalMinor - l.taxMinor, 0));

    // ---- an online order being collected: give its reservation back first, so the sale below is the only thing that takes the goods out
    if (p.onlineOrderId) await this.online.collectIn(tx, orgId, device.locationId, p.onlineOrderId, p.saleId, flag, p.lines);

    // ---- stock: tracked variants only; may go negative (flagged)
    const moves = p.lines.map((l, i) => ({ l, i })).filter(({ l }) => byId.get(l.variantId)!.v.trackStock)
      .map(({ l, i }) => ({ variantId: l.variantId, locationId: device.locationId, qtyDelta: -l.qty, kind: "sale" as const, sourceType: "sale", sourceId: p.saleId, lineNo: i, allowNegative: true, at, deviceId: device.id }));
    const r = moves.length ? await this.ledger.appendIn(tx, orgId, ctx.actorId, moves) : { negative: [] as { variantId: string; locationId: string; onHand: number }[] };
    if (r.negative.length) flag("negative_stock", { lines: r.negative });
    if (flags.length) await tx.update(sale).set({ flags: [...new Set(flags)] }).where(eq(sale.id, p.saleId));
    return { result: { saleId: p.saleId, receiptNo, totalMinor: client.totalMinor }, flags: [...new Set(flags)], exceptions };
  }
}
