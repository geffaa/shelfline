import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { resolvePrice, applyPromotions } from "@shelfline/pricing";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { location, priceBook, priceBookEntry, priceBookLocation, product, promotion, promotionLocation, promotionVariant, variant } from "../db/schema";
import { pricingFor } from "./scope";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface BookIn { name: string; priority: number; validFrom: string | null; validTo: string | null; locationIds: string[] }
export interface PromoIn { name: string; kind: "percent" | "amount_off"; valueBp: number; amountMinor: number; minQty: number; stackable: boolean; validFrom: string | null; validTo: string | null; variantIds: string[]; locationIds: string[] }
const dup = (e: any) => (e?.cause?.code ?? e?.code) === "23505";

/** Price books say what a variant sells for, where and when; promotions take money off a line. Both replicate to the tills, and the till prices offline with the same code (packages/pricing). */
@Injectable()
export class PricingService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}

  private async places(tx: Pick<Db, "select">, orgId: string, ids: string[]) {
    if (!ids.length) return; const r = await tx.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, ids)));
    if (r.length !== new Set(ids).size) throw new NotFoundException({ code: "location_not_found" });
  }
  private async variants(tx: Pick<Db, "select">, orgId: string, ids: string[]) {
    if (!ids.length) return; const r = await tx.select({ id: variant.id }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, ids)));
    if (r.length !== new Set(ids).size) throw new NotFoundException({ code: "variant_not_found" });
  }

  // ------------------------------------------------------------ price books
  async listBooks(orgId: string) {
    const r = await this.db.execute(sql`select b.id, b.name, b.priority, b.valid_from, b.valid_to, b.status, b.version,
        (select count(*)::int from shelfline.price_book_entry e where e.price_book_id = b.id) as entries,
        (select coalesce(array_agg(l.name order by l.name), '{}') from shelfline.price_book_location pl join shelfline.location l on l.id = pl.location_id where pl.price_book_id = b.id) as places
      from shelfline.price_book b where b.org_id = ${orgId} order by b.status, b.priority desc, lower(b.name)`);
    return r.rows.map((x: any) => ({ id: x.id, name: x.name, priority: x.priority, validFrom: x.valid_from, validTo: x.valid_to, status: x.status, version: x.version, entries: x.entries, places: x.places }));
  }
  async createBook(orgId: string, actorId: string, v: BookIn, ip: string | null) {
    await this.places(this.db, orgId, v.locationIds);
    try {
      return await this.db.transaction(async (tx) => {
        const [b] = await tx.insert(priceBook).values({ orgId, name: v.name, priority: v.priority, validFrom: v.validFrom, validTo: v.validTo }).returning();
        if (v.locationIds.length) await tx.insert(priceBookLocation).values(v.locationIds.map((locationId) => ({ priceBookId: b!.id, locationId })));
        await this.audit.record({ orgId, actorId, action: "price_book.create", subjectType: "price_book", subjectId: b!.id, after: v, ip }, tx); return b!;
      });
    } catch (e) { if (dup(e)) throw new ConflictException({ code: "name_taken" }); throw e; }
  }
  async getBook(orgId: string, id: string) {
    const [b] = await this.db.select().from(priceBook).where(and(eq(priceBook.id, id), eq(priceBook.orgId, orgId))); if (!b) throw new NotFoundException({ code: "price_book_not_found" });
    const places = await this.db.select({ id: location.id, name: location.name }).from(priceBookLocation).innerJoin(location, eq(location.id, priceBookLocation.locationId)).where(eq(priceBookLocation.priceBookId, id)).orderBy(asc(location.name));
    const entries = await this.db.select({ variantId: priceBookEntry.variantId, priceMinor: priceBookEntry.priceMinor, sku: variant.sku, options: variant.options, basePriceMinor: variant.basePriceMinor, title: product.title })
      .from(priceBookEntry).innerJoin(variant, eq(variant.id, priceBookEntry.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(eq(priceBookEntry.priceBookId, id)).orderBy(asc(product.title), asc(variant.sku));
    return { ...b, locations: places, entries };
  }
  async updateBook(orgId: string, actorId: string, id: string, v: Partial<BookIn> & { status?: "active" | "archived" }, ip: string | null) {
    if (v.locationIds) await this.places(this.db, orgId, v.locationIds);
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx.select().from(priceBook).where(and(eq(priceBook.id, id), eq(priceBook.orgId, orgId))).for("update"); if (!before) throw new NotFoundException({ code: "price_book_not_found" });
        const { locationIds, ...rest } = v; const set: Record<string, unknown> = { ...rest, version: sql`${priceBook.version} + 1` };
        const [b] = await tx.update(priceBook).set(set).where(eq(priceBook.id, id)).returning();
        if (locationIds) { await tx.delete(priceBookLocation).where(eq(priceBookLocation.priceBookId, id)); if (locationIds.length) await tx.insert(priceBookLocation).values(locationIds.map((locationId) => ({ priceBookId: id, locationId }))); }
        await this.audit.record({ orgId, actorId, action: "price_book.update", subjectType: "price_book", subjectId: id, before: { name: before.name, priority: before.priority, validFrom: before.validFrom, validTo: before.validTo, status: before.status }, after: v, ip }, tx); return b!;
      });
    } catch (e) { if (dup(e)) throw new ConflictException({ code: "name_taken" }); throw e; }
  }
  /** Set (upsert) or remove prices in one go; the book's version moves so tills know it changed. */
  async setEntries(orgId: string, actorId: string, id: string, v: { set: { variantId: string; priceMinor: number }[]; remove: string[] }, ip: string | null) {
    await this.variants(this.db, orgId, [...v.set.map((x) => x.variantId), ...v.remove]);
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(priceBook).where(and(eq(priceBook.id, id), eq(priceBook.orgId, orgId))).for("update"); if (!b) throw new NotFoundException({ code: "price_book_not_found" });
      for (const e of v.set) await tx.insert(priceBookEntry).values({ priceBookId: id, ...e }).onConflictDoUpdate({ target: [priceBookEntry.priceBookId, priceBookEntry.variantId], set: { priceMinor: e.priceMinor } });
      if (v.remove.length) await tx.delete(priceBookEntry).where(and(eq(priceBookEntry.priceBookId, id), inArray(priceBookEntry.variantId, v.remove)));
      const [u] = await tx.update(priceBook).set({ version: sql`${priceBook.version} + 1` }).where(eq(priceBook.id, id)).returning({ version: priceBook.version });
      await this.audit.record({ orgId, actorId, action: "price_book.entries", subjectType: "price_book", subjectId: id, after: { set: v.set.length, removed: v.remove.length, version: u!.version }, detail: { set: v.set.slice(0, 50) }, ip }, tx);
      return { version: u!.version, set: v.set.length, removed: v.remove.length };
    });
  }

  // ------------------------------------------------------------ promotions
  async listPromos(orgId: string) {
    const r = await this.db.execute(sql`select p.*, (select count(*)::int from shelfline.promotion_variant pv where pv.promotion_id = p.id) as variants,
        (select coalesce(array_agg(l.name order by l.name), '{}') from shelfline.promotion_location pl join shelfline.location l on l.id = pl.location_id where pl.promotion_id = p.id) as places
      from shelfline.promotion p where p.org_id = ${orgId} order by p.status, lower(p.name)`);
    return r.rows.map((x: any) => ({ id: x.id, name: x.name, kind: x.kind, valueBp: x.value_bp, amountMinor: x.amount_minor, minQty: x.min_qty, stackable: x.stackable, validFrom: x.valid_from, validTo: x.valid_to, status: x.status, version: x.version, variants: x.variants, places: x.places }));
  }
  async getPromo(orgId: string, id: string) {
    const [p] = await this.db.select().from(promotion).where(and(eq(promotion.id, id), eq(promotion.orgId, orgId))); if (!p) throw new NotFoundException({ code: "promotion_not_found" });
    const vs = await this.db.select({ variantId: variant.id, sku: variant.sku, options: variant.options, title: product.title }).from(promotionVariant).innerJoin(variant, eq(variant.id, promotionVariant.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(eq(promotionVariant.promotionId, id)).orderBy(asc(product.title));
    const places = await this.db.select({ id: location.id, name: location.name }).from(promotionLocation).innerJoin(location, eq(location.id, promotionLocation.locationId)).where(eq(promotionLocation.promotionId, id)).orderBy(asc(location.name));
    return { ...p, variants: vs, locations: places };
  }
  private shape(v: Partial<PromoIn>) {
    const k = v.kind; if (k === "percent" && v.amountMinor) throw new BadRequestException({ code: "percent_has_no_amount" }); if (k === "amount_off" && v.valueBp) throw new BadRequestException({ code: "amount_has_no_percent" });
  }
  async createPromo(orgId: string, actorId: string, v: PromoIn, ip: string | null) {
    this.shape(v); await this.places(this.db, orgId, v.locationIds); await this.variants(this.db, orgId, v.variantIds);
    try {
      return await this.db.transaction(async (tx) => {
        const { variantIds, locationIds, ...row } = v; const [p] = await tx.insert(promotion).values({ orgId, ...row }).returning();
        if (variantIds.length) await tx.insert(promotionVariant).values(variantIds.map((variantId) => ({ promotionId: p!.id, variantId })));
        if (locationIds.length) await tx.insert(promotionLocation).values(locationIds.map((locationId) => ({ promotionId: p!.id, locationId })));
        await this.audit.record({ orgId, actorId, action: "promotion.create", subjectType: "promotion", subjectId: p!.id, after: { ...row, variants: variantIds.length, locations: locationIds.length }, ip }, tx); return p!;
      });
    } catch (e) { if (dup(e)) throw new ConflictException({ code: "name_taken" }); throw e; }
  }
  async updatePromo(orgId: string, actorId: string, id: string, v: Partial<PromoIn> & { status?: "active" | "archived" }, ip: string | null) {
    if (v.locationIds) await this.places(this.db, orgId, v.locationIds); if (v.variantIds) await this.variants(this.db, orgId, v.variantIds);
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx.select().from(promotion).where(and(eq(promotion.id, id), eq(promotion.orgId, orgId))).for("update"); if (!before) throw new NotFoundException({ code: "promotion_not_found" });
        const merged = { kind: v.kind ?? before.kind as PromoIn["kind"], valueBp: v.valueBp ?? before.valueBp, amountMinor: v.amountMinor ?? before.amountMinor }; this.shape(merged);
        const { variantIds, locationIds, ...rest } = v; const [p] = await tx.update(promotion).set({ ...rest, version: sql`${promotion.version} + 1` }).where(eq(promotion.id, id)).returning();
        if (variantIds) { await tx.delete(promotionVariant).where(eq(promotionVariant.promotionId, id)); if (variantIds.length) await tx.insert(promotionVariant).values(variantIds.map((variantId) => ({ promotionId: id, variantId }))); }
        if (locationIds) { await tx.delete(promotionLocation).where(eq(promotionLocation.promotionId, id)); if (locationIds.length) await tx.insert(promotionLocation).values(locationIds.map((locationId) => ({ promotionId: id, locationId }))); }
        await this.audit.record({ orgId, actorId, action: "promotion.update", subjectType: "promotion", subjectId: id, before: { name: before.name, kind: before.kind, valueBp: before.valueBp, amountMinor: before.amountMinor, status: before.status }, after: v, ip }, tx); return p!;
      });
    } catch (e) { if (dup(e)) throw new ConflictException({ code: "name_taken" }); throw e; }
  }

  /** What a variant would sell for at a place on a date: the same two functions the till runs. */
  async preview(orgId: string, v: { variantId: string; locationId: string; onDate: string; qty: number }) {
    const [row] = await this.db.select({ base: variant.basePriceMinor, sku: variant.sku, title: product.title }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.id, v.variantId), eq(variant.orgId, orgId)));
    if (!row) throw new NotFoundException({ code: "variant_not_found" }); await this.places(this.db, orgId, [v.locationId]);
    const px = await pricingFor(this.db, orgId, v.locationId); const price = resolvePrice(v.variantId, row.base, v.onDate, px.books);
    const [promo] = applyPromotions([{ variantId: v.variantId, unitPriceMinor: price.unitPriceMinor, qty: v.qty }], px.promos, v.onDate);
    return { sku: row.sku, title: row.title, basePriceMinor: row.base, unitPriceMinor: price.unitPriceMinor, priceBookId: price.priceBookId, promoDiscountMinor: promo!.discountMinor, promotionIds: promo!.promotionIds, lineTotalMinor: price.unitPriceMinor * v.qty - promo!.discountMinor, pricingVersion: px.version };
  }
}
export type { Tx };
