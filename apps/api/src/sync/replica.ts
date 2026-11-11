import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { ReplicaEntityType, ReplicaItem } from "@shelfline/contracts";
import type { Db } from "../db/db.module";
import { category, customer, location, product, register, stockBalance, taxClass, taxRate, variant, priceBookEntry } from "../db/schema";
import { booksFor, promosFor } from "../pricing/scope";

/**
 * What a POS may hold of each entity. Deliberately narrow: no cost, no staff, no other locations.
 * Variant cost is left out so a till never carries purchase prices.
 */
export const SNAPSHOT_ORDER: ReplicaEntityType[] = ["location", "register", "category", "tax_class", "tax_rate", "product", "variant", "stock_balance", "customer", "price_book", "price_book_entry", "promotion"];

type Row = Record<string, unknown>;
const day = (x: Date | string | null) => (x === null ? null : typeof x === "string" ? x : x.toISOString().slice(0, 10));
const bookRow = (r: { id: string; name: string; priority: number; validFrom: string | Date | null; validTo: string | Date | null; version: number }): Row => ({ id: r.id, name: r.name, priority: r.priority, validFrom: day(r.validFrom), validTo: day(r.validTo), version: r.version });
const promoRow = (r: { id: string; name: string; kind: string; valueBp: number; amountMinor: number; minQty: number; stackable: boolean; validFrom: string | Date | null; validTo: string | Date | null; version: number; variantIds: string[] | null }): Row => ({ id: r.id, name: r.name, kind: r.kind, valueBp: r.valueBp, amountMinor: r.amountMinor, minQty: r.minQty, stackable: r.stackable, validFrom: day(r.validFrom), validTo: day(r.validTo), version: r.version, variantIds: r.variantIds });
const iso = (d: Date | string | null) => (d instanceof Date ? d.toISOString() : d);

export async function loadEntities(db: Db, orgId: string, locationId: string, type: ReplicaEntityType, ids: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  if (!ids.length) return out;
  switch (type) {
    case "product": for (const r of await db.select().from(product).where(and(eq(product.orgId, orgId), inArray(product.id, ids)))) out.set(r.id, { id: r.id, title: r.title, categoryId: r.categoryId, taxClassId: r.taxClassId, brand: r.brand, status: r.status, version: r.version }); break;
    case "variant": for (const r of await db.select().from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, ids)))) out.set(r.id, { id: r.id, productId: r.productId, sku: r.sku, barcode: r.barcode, options: r.options, basePriceMinor: r.basePriceMinor, trackStock: r.trackStock, status: r.status, version: r.version }); break;
    case "category": for (const r of await db.select().from(category).where(and(eq(category.orgId, orgId), inArray(category.id, ids)))) out.set(r.id, { id: r.id, name: r.name }); break;
    case "tax_class": for (const r of await db.select().from(taxClass).where(and(eq(taxClass.orgId, orgId), inArray(taxClass.id, ids)))) out.set(r.id, { id: r.id, key: r.key, name: r.name }); break;
    case "tax_rate": for (const r of await db.select({ r: taxRate }).from(taxRate).innerJoin(taxClass, eq(taxClass.id, taxRate.taxClassId)).where(and(eq(taxClass.orgId, orgId), inArray(taxRate.id, ids)))) out.set(r.r.id, { id: r.r.id, taxClassId: r.r.taxClassId, region: r.r.region, rateBp: r.r.rateBp, inclusive: r.r.taxInclusive, validFrom: r.r.validFrom, validTo: r.r.validTo }); break;
    case "location": for (const r of await db.select().from(location).where(and(eq(location.orgId, orgId), eq(location.id, locationId), inArray(location.id, ids)))) out.set(r.id, { id: r.id, code: r.code, name: r.name, type: r.type, timezone: r.timezone, dayCutoff: r.dayCutoff, taxRegion: r.taxRegion, cashierDiscountLimitBp: r.cashierDiscountLimitBp, cashierRefundLimitMinor: r.cashierRefundLimitMinor, cashVarianceLimitMinor: r.cashVarianceLimitMinor, giftCardOffline: r.giftCardOffline, giftCardOfflineCapMinor: r.giftCardOfflineCapMinor, status: r.status }); break;
    case "customer": for (const r of await db.select().from(customer).where(and(eq(customer.orgId, orgId), inArray(customer.id, ids)))) out.set(r.id, { id: r.id, name: r.name, email: r.email, phone: r.phone }); break;
    case "register": for (const r of await db.select().from(register).where(and(eq(register.orgId, orgId), eq(register.locationId, locationId), inArray(register.id, ids)))) out.set(r.id, { id: r.id, code: r.code, name: r.name, status: r.status }); break;
    case "price_book": for (const r of await booksFor(db, orgId, locationId, ids)) out.set(r.id, bookRow(r)); break;
    case "promotion": for (const r of await promosFor(db, orgId, locationId, ids)) out.set(r.id, promoRow(r)); break;
    case "price_book_entry": {
      const pairs = ids.map((i) => i.split(":") as [string, string]); const live = new Set((await booksFor(db, orgId, locationId, [...new Set(pairs.map(([b]) => b))])).map((b) => b.id));
      const want = pairs.filter(([b]) => live.has(b)); if (!want.length) break;
      for (const r of await db.select().from(priceBookEntry).where(and(inArray(priceBookEntry.priceBookId, [...new Set(want.map(([b]) => b))]), inArray(priceBookEntry.variantId, [...new Set(want.map(([, v]) => v))])))) if (want.some(([b, v]) => b === r.priceBookId && v === r.variantId)) out.set(`${r.priceBookId}:${r.variantId}`, { bookId: r.priceBookId, variantId: r.variantId, priceMinor: r.priceMinor });
      break;
    }
    case "stock_balance": {
      const pairs = ids.map((i) => i.split(":") as [string, string]).filter(([, l]) => l === locationId).map(([v]) => v);
      for (const r of pairs.length ? await db.select().from(stockBalance).where(and(eq(stockBalance.orgId, orgId), eq(stockBalance.locationId, locationId), inArray(stockBalance.variantId, pairs))) : [])
        out.set(`${r.variantId}:${r.locationId}`, { variantId: r.variantId, locationId: r.locationId, onHand: r.onHand });
      break;
    }
  }
  return out;
}

/** Keyset page of one entity type for the initial download. */
export async function snapshotPage(db: Db, orgId: string, locationId: string, type: ReplicaEntityType, afterId: string | null, limit: number): Promise<ReplicaItem[]> {
  const after = (col: Parameters<typeof gt>[0]) => (afterId ? gt(col, afterId) : undefined);
  const mk = (rows: { id: string }[], conv: (r: any) => Row): ReplicaItem[] => rows.map((r) => ({ type, id: r.id, op: "upsert", data: conv(r) }));
  switch (type) {
    case "location": return afterId ? [] : mk(await db.select().from(location).where(and(eq(location.orgId, orgId), eq(location.id, locationId))), (r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, timezone: r.timezone, dayCutoff: r.dayCutoff, taxRegion: r.taxRegion, cashierDiscountLimitBp: r.cashierDiscountLimitBp, cashierRefundLimitMinor: r.cashierRefundLimitMinor, cashVarianceLimitMinor: r.cashVarianceLimitMinor, giftCardOffline: r.giftCardOffline, giftCardOfflineCapMinor: r.giftCardOfflineCapMinor, status: r.status }));
    case "customer": return mk(await db.select().from(customer).where(and(eq(customer.orgId, orgId), after(customer.id))).orderBy(asc(customer.id)).limit(limit), (r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone }));
    case "register": return mk(await db.select().from(register).where(and(eq(register.orgId, orgId), eq(register.locationId, locationId), after(register.id))).orderBy(asc(register.id)).limit(limit), (r) => ({ id: r.id, code: r.code, name: r.name, status: r.status }));
    case "category": return mk(await db.select().from(category).where(and(eq(category.orgId, orgId), after(category.id))).orderBy(asc(category.id)).limit(limit), (r) => ({ id: r.id, name: r.name }));
    case "tax_class": return mk(await db.select().from(taxClass).where(and(eq(taxClass.orgId, orgId), after(taxClass.id))).orderBy(asc(taxClass.id)).limit(limit), (r) => ({ id: r.id, key: r.key, name: r.name }));
    case "tax_rate": return mk((await db.select({ r: taxRate }).from(taxRate).innerJoin(taxClass, eq(taxClass.id, taxRate.taxClassId)).where(and(eq(taxClass.orgId, orgId), after(taxRate.id))).orderBy(asc(taxRate.id)).limit(limit)).map((x) => x.r), (r) => ({ id: r.id, taxClassId: r.taxClassId, region: r.region, rateBp: r.rateBp, inclusive: r.taxInclusive, validFrom: r.validFrom, validTo: r.validTo }));
    case "product": return mk(await db.select().from(product).where(and(eq(product.orgId, orgId), after(product.id))).orderBy(asc(product.id)).limit(limit), (r) => ({ id: r.id, title: r.title, categoryId: r.categoryId, taxClassId: r.taxClassId, brand: r.brand, status: r.status, version: r.version }));
    case "variant": return mk(await db.select().from(variant).where(and(eq(variant.orgId, orgId), after(variant.id))).orderBy(asc(variant.id)).limit(limit), (r) => ({ id: r.id, productId: r.productId, sku: r.sku, barcode: r.barcode, options: r.options, basePriceMinor: r.basePriceMinor, trackStock: r.trackStock, status: r.status, version: r.version }));
    case "price_book": return (await booksFor(db, orgId, locationId)).filter((b) => !afterId || b.id > afterId).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit).map((r) => ({ type, id: r.id, op: "upsert" as const, data: bookRow(r) }));
    case "promotion": return (await promosFor(db, orgId, locationId)).filter((p) => !afterId || p.id > afterId).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit).map((r) => ({ type, id: r.id, op: "upsert" as const, data: promoRow(r) }));
    case "price_book_entry": {
      const live = (await booksFor(db, orgId, locationId)).map((b) => b.id); if (!live.length) return [];
      const rows = await db.select().from(priceBookEntry).where(and(inArray(priceBookEntry.priceBookId, live), afterId ? sql`(${priceBookEntry.priceBookId}::text || ':' || ${priceBookEntry.variantId}::text) > ${afterId}` : undefined)).orderBy(sql`${priceBookEntry.priceBookId}::text || ':' || ${priceBookEntry.variantId}::text`).limit(limit);
      return rows.map((r) => ({ type, id: `${r.priceBookId}:${r.variantId}`, op: "upsert" as const, data: { bookId: r.priceBookId, variantId: r.variantId, priceMinor: r.priceMinor } }));
    }
    case "stock_balance": {
      const rows = await db.select().from(stockBalance).where(and(eq(stockBalance.orgId, orgId), eq(stockBalance.locationId, locationId), after(stockBalance.variantId))).orderBy(asc(stockBalance.variantId)).limit(limit);
      return rows.map((r) => ({ type, id: `${r.variantId}:${r.locationId}`, op: "upsert" as const, data: { variantId: r.variantId, locationId: r.locationId, onHand: r.onHand } }));
    }
  }
}
export const snapshotKey = (type: ReplicaEntityType, item: ReplicaItem) => (type === "stock_balance" ? item.id.split(":")[0]! : item.id);
void sql; void iso;
