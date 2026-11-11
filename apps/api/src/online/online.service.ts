import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { priceCart, resolvePrice, resolveTaxRule, type RateRow } from "@shelfline/pricing";
import { MailService } from "../access/mail.service";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { businessDate } from "../common/business-day";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { category, location, onlineOrder, onlineOrderLine, org, product, taxRate, variant } from "../db/schema";
import { InsufficientStock, LedgerService, type Tx } from "../inventory/ledger.service";
import { pricingFor } from "../pricing/scope";

type Row = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";                         // no 0/O, 1/I
const HOLD_HOURS = 48;
export interface OrderIn { email: string; name: string; phone?: string | null; locationId: string; lines: { variantId: string; qty: number }[] }
const same = (a: string, b: string) => { const x = Buffer.from(sha(a)), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** The online store: browse what is in stock where, reserve it at a store, collect and pay at the counter. A reservation is a ledger outflow, so what the shopper sees as "available" is the same number the tills use. */
@Injectable()
export class OnlineService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null; private logger = new Logger("online");
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(LedgerService) private ledger: LedgerService, @Inject(MailService) private mail: MailService, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.expireStale().catch((e) => this.logger.warn(`expire: ${String(e)}`)); }, 60_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ------------------------------------------------------------ browsing (no sign-in)
  /** The shop an unaddressed storefront shows: the one organisation, or the one named by its slug when there are several. */
  async onlyOrg(slug?: string) { const rows = await this.db.select({ id: org.id }).from(org).where(slug ? eq(org.slug, slug.toLowerCase()) : undefined).limit(2); if (rows.length !== 1) throw new NotFoundException({ code: rows.length ? "several_shops" : "no_shop" }); return { orgId: rows[0]!.id }; }
  private async pickupPlaces(orgId: string) { return this.db.select({ id: location.id, name: location.name, timezone: location.timezone }).from(location).where(and(eq(location.orgId, orgId), eq(location.pickupEnabled, true), eq(location.status, "active"))).orderBy(asc(location.name)); }
  async storefront(orgId: string) {
    const [o] = await this.db.select({ id: org.id, name: org.name, currency: org.currency }).from(org).where(eq(org.id, orgId)); if (!o) throw new NotFoundException({ code: "shop_not_found" });
    return { name: o.name, currency: o.currency, stores: await this.pickupPlaces(orgId), categories: await this.db.select({ id: category.id, name: category.name }).from(category).where(eq(category.orgId, orgId)).orderBy(asc(category.name)) };
  }
  async catalog(orgId: string, o: { q?: string; categoryId?: string; limit?: number; offset?: number }) {
    const places = await this.pickupPlaces(orgId); const ids = places.map((p) => p.id);
    const raw = (o.q ?? "").trim().toLowerCase(); const q = raw.replace(/[%_\\]/g, ""); if (raw && !q) return { products: [] };        // a search made only of wildcard characters finds nothing, not everything
    const rows = (await this.db.execute(sql`
      select p.id, p.title, p.brand, p.category_id, min(v.base_price_minor)::int as from_price, max(v.base_price_minor)::int as to_price, count(v.id)::int as variants,
        coalesce(sum(case when b.location_id in (${ids.length ? sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `) : sql`'00000000-0000-0000-0000-000000000000'::uuid`}) then greatest(b.on_hand, 0) else 0 end), 0)::int as available
      from shelfline.product p join shelfline.variant v on v.product_id = p.id and v.status = 'active' left join shelfline.stock_balance b on b.variant_id = v.id
      where p.org_id = ${orgId} and p.status = 'active' ${o.categoryId ? sql`and p.category_id = ${o.categoryId}::uuid` : sql``} ${q ? sql`and (lower(p.title) like ${"%" + q + "%"} or lower(coalesce(p.brand, '')) like ${"%" + q + "%"})` : sql``}
      group by p.id order by p.title limit ${Math.min(o.limit ?? 48, 100)} offset ${o.offset ?? 0}`)).rows as Row[];
    return { products: rows.map((r) => ({ id: r.id, title: r.title, brand: r.brand, categoryId: r.category_id, fromPriceMinor: Number(r.from_price), toPriceMinor: Number(r.to_price), variants: Number(r.variants), available: Number(r.available), inStock: Number(r.available) > 0 })) };
  }
  async productPage(orgId: string, productId: string) {
    const [p] = await this.db.select().from(product).where(and(eq(product.id, productId), eq(product.orgId, orgId), eq(product.status, "active"))); if (!p) throw new NotFoundException({ code: "product_not_found" });
    const places = await this.pickupPlaces(orgId); const vs = await this.db.select().from(variant).where(and(eq(variant.productId, productId), eq(variant.status, "active"))).orderBy(asc(variant.sku));
    const bal = vs.length && places.length ? (await this.db.execute(sql`select variant_id::text as v, location_id::text as l, on_hand from shelfline.stock_balance where variant_id in (${sql.join(vs.map((v) => sql`${v.id}::uuid`), sql`, `)}) and location_id in (${sql.join(places.map((l) => sql`${l.id}::uuid`), sql`, `)})`)).rows as Row[] : [];
    return { id: p.id, title: p.title, brand: p.brand, stores: places, variants: vs.map((v) => ({ id: v.id, sku: v.sku, options: v.options, priceMinor: v.basePriceMinor, tracked: v.trackStock, availability: places.map((l) => ({ locationId: l.id, store: l.name, available: v.trackStock ? Math.max(0, Number(bal.find((b) => b.v === v.id && b.l === l.id)?.on_hand ?? 0)) : 99 })) })) };
  }

  // ------------------------------------------------------------ ordering
  /** All-or-nothing: every line is reserved at the chosen store in one transaction. Two shoppers after the last pair: one gets it, the other is told how many are left. */
  async place(orgId: string, v: OrderIn, now = new Date()) {
    if (!v.lines.length) throw new BadRequestException({ code: "empty_cart" });
    const merged = new Map<string, number>(); for (const l of v.lines) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.qty); const want = [...merged].map(([variantId, qty]) => ({ variantId, qty }));
    const [loc] = await this.db.select().from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId), eq(location.pickupEnabled, true), eq(location.status, "active"))); if (!loc) throw new ConflictException({ code: "store_not_available_for_pickup" });
    const token = randomBytes(18).toString("hex");
    for (let attempt = 0; ; attempt++) {
    const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    try {
      const out = await this.db.transaction(async (tx) => {
        const vs = await tx.select({ v: variant, p: product }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.orgId, orgId), inArray(variant.id, want.map((w) => w.variantId)), eq(variant.status, "active"), eq(product.status, "active")));
        if (vs.length !== want.length) throw new NotFoundException({ code: "variant_not_found" });
        const date = businessDate(now, loc.timezone, loc.dayCutoff); const px = await pricingFor(tx, orgId, loc.id);
        const rates = await tx.select().from(taxRate).where(inArray(taxRate.taxClassId, [...new Set(vs.map((x) => x.p.taxClassId))]));
        const ratesFor = (cid: string): RateRow[] => rates.filter((r) => r.taxClassId === cid).map((r) => ({ region: r.region, rateBp: r.rateBp, taxInclusive: r.taxInclusive, validFrom: r.validFrom, validTo: r.validTo }));
        const items = want.map((w) => { const x = vs.find((y) => y.v.id === w.variantId)!; const price = resolvePrice(x.v.id, x.v.basePriceMinor, date, px.books); return { ...w, x, unit: price.unitPriceMinor, tax: resolveTaxRule(ratesFor(x.p.taxClassId), loc.taxRegion, date) ?? { rateBp: 0, inclusive: true } }; });
        const priced = priceCart(items.map((i) => ({ variantId: i.variantId, qty: i.qty, unitPriceMinor: i.unit, discountMinor: 0, tax: i.tax })));
        const n = Number(((await tx.execute(sql`select nextval('shelfline.online_order_seq')::int as n`)).rows[0] as { n: number }).n); const number = `ON-${String(n).padStart(6, "0")}`;
        const [o] = await tx.select({ c: org.currency }).from(org).where(eq(org.id, orgId));
        const [order] = await tx.insert(onlineOrder).values({ orgId, number, locationId: loc.id, customerEmail: v.email.trim().toLowerCase(), customerName: v.name.trim(), customerPhone: v.phone?.trim() || null, pickupCodeHash: sha(code), accessTokenHash: sha(token),
          subtotalMinor: priced.subtotalMinor, taxMinor: priced.taxMinor, totalMinor: priced.totalMinor, currency: o!.c, placedAt: now, expiresAt: new Date(now.getTime() + HOLD_HOURS * 3_600_000) }).returning();
        await tx.insert(onlineOrderLine).values(items.map((i, k) => ({ orderId: order!.id, lineNo: k, variantId: i.variantId, title: i.x.p.title, optionsLabel: Object.values((i.x.v.options ?? {}) as Record<string, string>).join(" · "), qty: i.qty, unitPriceMinor: i.unit, totalMinor: priced.lines[k]!.totalMinor, taxMinor: priced.lines[k]!.taxMinor })));
        const tracked = items.map((i, k) => ({ i, k })).filter(({ i }) => i.x.v.trackStock);
        if (tracked.length) await this.ledger.appendIn(tx, orgId, null, tracked.map(({ i, k }) => ({ variantId: i.variantId, locationId: loc.id, qtyDelta: -i.qty, kind: "online_reserve" as const, sourceType: "online_order", sourceId: order!.id, lineNo: k, at: now })));
        await this.mail.send(orgId, { to: order!.customerEmail, kind: "online_order", subject: `Order ${number} is reserved at ${loc.name}`, body: `Thanks, ${order!.customerName}. We are holding your order at ${loc.name} until ${new Date(order!.expiresAt).toLocaleString("en-AU", { timeZone: loc.timezone, dateStyle: "medium", timeStyle: "short" })}.\nYour pickup code is ${code}. Show it at the counter and pay then.\nTotal ${(priced.totalMinor / 100).toFixed(2)} including GST.` }, tx);
        return { id: order!.id, number, total: priced.totalMinor, expiresAt: order!.expiresAt };
      });
      return { ...out, pickupCode: code, accessToken: token, store: loc.name };
    } catch (e) {
      if (e instanceof InsufficientStock) throw new ConflictException({ code: "insufficient_stock", variantId: e.variantId, available: Math.max(0, e.onHand), wanted: e.wanted });
      if (attempt < 3 && ((e as { cause?: { code?: string; constraint?: string } }).cause?.constraint === "online_order_code_uq")) continue;       // two open orders at one store drew the same code: draw again
      throw e;
    }
    }
  }
  async customerView(orgId: string, id: string, token: string) {
    const [o] = await this.db.select().from(onlineOrder).where(and(eq(onlineOrder.id, id), eq(onlineOrder.orgId, orgId))); if (!o || !same(token, o.accessTokenHash)) throw new NotFoundException({ code: "order_not_found" });
    const [loc] = await this.db.select({ name: location.name }).from(location).where(eq(location.id, o.locationId)); const lines = await this.db.select().from(onlineOrderLine).where(eq(onlineOrderLine.orderId, id)).orderBy(asc(onlineOrderLine.lineNo));
    return { id: o.id, number: o.number, status: o.status, store: loc?.name, name: o.customerName, totalMinor: o.totalMinor, taxMinor: o.taxMinor, currency: o.currency, placedAt: o.placedAt, expiresAt: o.expiresAt, readyAt: o.readyAt, lines: lines.map((l) => ({ title: l.title, options: l.optionsLabel, qty: l.qty, totalMinor: l.totalMinor })) };
  }
  async customerCancel(orgId: string, id: string, token: string) {
    const [o] = await this.db.select().from(onlineOrder).where(and(eq(onlineOrder.id, id), eq(onlineOrder.orgId, orgId))); if (!o || !same(token, o.accessTokenHash)) throw new NotFoundException({ code: "order_not_found" });
    return this.cancelIn(o.id, "cancelled", "Cancelled by the customer", null);
  }

  // ------------------------------------------------------------ staff
  private async load(orgId: string, id: string) { const [o] = await this.db.select().from(onlineOrder).where(and(eq(onlineOrder.id, id), eq(onlineOrder.orgId, orgId))); if (!o) throw new NotFoundException({ code: "order_not_found" }); return o; }
  private async need(userId: string, locationId: string) { if (!(await this.authz.can(userId, "sale:read", locationId))) throw new ForbiddenException({ code: "forbidden", permission: "sale:read", locationId }); }
  async list(orgId: string, userId: string, o: { status?: string; locationId?: string }) {
    const sc = await this.authz.scope(userId, "sale:read"); if (!sc.all && !sc.locationIds.length) return [];
    const rows = await this.db.select({ o: onlineOrder, l: location.name }).from(onlineOrder).innerJoin(location, eq(location.id, onlineOrder.locationId)).where(and(eq(onlineOrder.orgId, orgId), o.status ? eq(onlineOrder.status, o.status) : undefined, o.locationId ? eq(onlineOrder.locationId, o.locationId) : undefined)).orderBy(desc(onlineOrder.placedAt)).limit(200);
    const ids = rows.filter(({ o: x }) => sc.all || sc.locationIds.includes(x.locationId)).map(({ o: x }) => x.id); const lines = ids.length ? await this.db.select().from(onlineOrderLine).where(inArray(onlineOrderLine.orderId, ids)).orderBy(asc(onlineOrderLine.lineNo)) : [];
    return rows.filter(({ o: x }) => ids.includes(x.id)).map(({ o: x, l }) => ({ id: x.id, number: x.number, status: x.status, store: l, locationId: x.locationId, customer: x.customerName, email: x.customerEmail, phone: x.customerPhone, totalMinor: x.totalMinor, placedAt: x.placedAt, expiresAt: x.expiresAt, readyAt: x.readyAt, collectedAt: x.collectedAt, cancelReason: x.cancelReason, saleId: x.saleId, lines: lines.filter((y) => y.orderId === x.id).map((y) => ({ lineNo: y.lineNo, variantId: y.variantId, title: y.title, options: y.optionsLabel, qty: y.qty, unitPriceMinor: y.unitPriceMinor, totalMinor: y.totalMinor })) }));
  }
  async ready(orgId: string, actorId: string, id: string, ip: string | null) {
    const o = await this.load(orgId, id); await this.need(actorId, o.locationId); if (o.status === "ready") return { id, status: "ready" }; if (o.status !== "placed") throw new ConflictException({ code: "not_placed", status: o.status });
    const [loc] = await this.db.select({ name: location.name }).from(location).where(eq(location.id, o.locationId));
    await this.db.transaction(async (tx) => { await tx.update(onlineOrder).set({ status: "ready", readyAt: new Date() }).where(eq(onlineOrder.id, id)); await this.audit.record({ orgId, actorId, action: "online_order.ready", subjectType: "online_order", subjectId: id, ip }, tx);
      await this.mail.send(orgId, { to: o.customerEmail, kind: "online_order_ready", subject: `Order ${o.number} is ready to collect`, body: `Your order is ready at ${loc!.name}. Bring your pickup code and pay at the counter. We will hold it until ${o.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.` }, tx); });
    return { id, status: "ready" };
  }
  async cancel(orgId: string, actorId: string, id: string, reason: string, ip: string | null) { const o = await this.load(orgId, id); await this.need(actorId, o.locationId); const r = await this.cancelIn(id, "cancelled", reason, actorId); await this.audit.record({ orgId, actorId, action: "online_order.cancel", subjectType: "online_order", subjectId: id, detail: { reason }, ip }); return r; }

  /** Puts the stock back (an `online_release` for every line) and ends the order. Safe to repeat: a finished order is left alone. */
  private async cancelIn(id: string, status: "cancelled" | "expired", reason: string, by: string | null) {
    return this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(onlineOrder).where(eq(onlineOrder.id, id)).for("update"); if (!o) throw new NotFoundException({ code: "order_not_found" });
      if (o.status === "cancelled" || o.status === "expired") return { id, status: o.status }; if (o.status === "collected") throw new ConflictException({ code: "already_collected" });
      await this.releaseIn(tx, o.orgId, o.id, o.locationId, "online_order_release");
      await tx.update(onlineOrder).set({ status, cancelledAt: new Date(), cancelledBy: by, cancelReason: reason }).where(eq(onlineOrder.id, id)); return { id, status };
    });
  }
  private async releaseIn(tx: Tx, orgId: string, orderId: string, locationId: string, sourceType: string) {
    const lines = await tx.select({ l: onlineOrderLine, track: variant.trackStock }).from(onlineOrderLine).innerJoin(variant, eq(variant.id, onlineOrderLine.variantId)).where(eq(onlineOrderLine.orderId, orderId)).orderBy(asc(onlineOrderLine.lineNo));
    const t = lines.filter((x) => x.track); if (t.length) await this.ledger.appendIn(tx, orgId, null, t.map(({ l }) => ({ variantId: l.variantId, locationId, qtyDelta: l.qty, kind: "online_release" as const, sourceType, sourceId: orderId, lineNo: l.lineNo })));
  }
  /** Orders nobody came for. Run every minute and callable directly. */
  async expireStale(now = new Date()) {
    const due = await this.db.select({ id: onlineOrder.id }).from(onlineOrder).where(and(inArray(onlineOrder.status, ["placed", "ready"]), sql`${onlineOrder.expiresAt} <= ${now.toISOString()}::timestamptz`)); let n = 0;
    for (const d of due) { const r = await this.cancelIn(d.id, "expired", "Not collected in time", null); if (r.status === "expired") n++; } return n;
  }

  // ------------------------------------------------------------ the till
  /** Looks an order up by its pickup code, at the till's own store only. */
  async lookup(orgId: string, locationId: string, code: string) {
    const [o] = await this.db.select().from(onlineOrder).where(and(eq(onlineOrder.orgId, orgId), eq(onlineOrder.locationId, locationId), eq(onlineOrder.pickupCodeHash, sha(code.trim().toUpperCase())), inArray(onlineOrder.status, ["placed", "ready"]))); if (!o) throw new NotFoundException({ code: "order_not_found" });
    const lines = await this.db.select().from(onlineOrderLine).where(eq(onlineOrderLine.orderId, o.id)).orderBy(asc(onlineOrderLine.lineNo));
    return { id: o.id, number: o.number, status: o.status, customer: o.customerName, totalMinor: o.totalMinor, expiresAt: o.expiresAt, lines: lines.map((l) => ({ variantId: l.variantId, title: l.title, options: l.optionsLabel, qty: l.qty, unitPriceMinor: l.unitPriceMinor, totalMinor: l.totalMinor })) };
  }
  /** Called inside the sale: the reservation is given back and the order is marked collected, so the sale's own stock movement is the only thing that takes the goods out. */
  async collectIn(tx: Tx, orgId: string, locationId: string, orderId: string, saleId: string, flag: (k: string, d?: unknown) => void, saleLines: { variantId: string; qty: number }[]) {
    const [o] = await tx.select().from(onlineOrder).where(and(eq(onlineOrder.id, orderId), eq(onlineOrder.orgId, orgId))).for("update");
    if (!o || o.locationId !== locationId) return flag("online_order_unknown", { orderId });
    if (o.status !== "placed" && o.status !== "ready") return flag("online_order_not_open", { orderId, status: o.status });
    await this.releaseIn(tx, orgId, o.id, o.locationId, "online_order_collect"); await tx.update(onlineOrder).set({ status: "collected", collectedAt: new Date(), saleId }).where(eq(onlineOrder.id, o.id));
    const lines = await tx.select().from(onlineOrderLine).where(eq(onlineOrderLine.orderId, o.id)); const sold = new Map<string, number>(); for (const l of saleLines) sold.set(l.variantId, (sold.get(l.variantId) ?? 0) + l.qty);
    const differs = lines.some((l) => sold.get(l.variantId) !== l.qty) || sold.size !== lines.length; if (differs) flag("online_order_differs", { orderId, ordered: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })) });
  }
}
