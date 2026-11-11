import { and, eq, inArray, sql } from "drizzle-orm";
import type { BookView, PromoView } from "@shelfline/pricing";
import type { Db } from "../db/db.module";
import { priceBook, priceBookEntry, priceBookLocation, promotion, promotionLocation, promotionVariant } from "../db/schema";

type Q = Pick<Db, "select">;
const d = (x: string | Date | null) => (x === null ? null : typeof x === "string" ? x : x.toISOString().slice(0, 10));

/** Active books that apply at a location: no location rows means everywhere. */
export async function booksFor(db: Q, orgId: string, locationId: string, ids?: string[]) {
  const rows = await db.select().from(priceBook).where(and(eq(priceBook.orgId, orgId), eq(priceBook.status, "active"), ids ? inArray(priceBook.id, ids) : undefined,
    sql`(not exists (select 1 from ${priceBookLocation} pl where pl.price_book_id = ${priceBook.id}) or exists (select 1 from ${priceBookLocation} pl where pl.price_book_id = ${priceBook.id} and pl.location_id = ${locationId}))`));
  return rows;
}
export async function promosFor(db: Q, orgId: string, locationId: string, ids?: string[]) {
  const rows = await db.select().from(promotion).where(and(eq(promotion.orgId, orgId), eq(promotion.status, "active"), ids ? inArray(promotion.id, ids) : undefined,
    sql`(not exists (select 1 from ${promotionLocation} pl where pl.promotion_id = ${promotion.id}) or exists (select 1 from ${promotionLocation} pl where pl.promotion_id = ${promotion.id} and pl.location_id = ${locationId}))`));
  const vs = rows.length ? await db.select().from(promotionVariant).where(inArray(promotionVariant.promotionId, rows.map((r) => r.id))) : [];
  return rows.map((r) => { const v = vs.filter((x) => x.promotionId === r.id).map((x) => x.variantId); return { ...r, variantIds: v.length ? v : null }; });
}

/** Everything the pure pricing functions need for one location (server checks and the admin preview). */
export async function pricingFor(db: Q, orgId: string, locationId: string): Promise<{ books: BookView[]; promos: PromoView[]; version: number }> {
  const books = await booksFor(db, orgId, locationId); const promos = await promosFor(db, orgId, locationId);
  const entries = books.length ? await db.select().from(priceBookEntry).where(inArray(priceBookEntry.priceBookId, books.map((b) => b.id))) : [];
  return {
    books: books.map((b) => ({ id: b.id, priority: b.priority, validFrom: d(b.validFrom), validTo: d(b.validTo), prices: Object.fromEntries(entries.filter((e) => e.priceBookId === b.id).map((e) => [e.variantId, e.priceMinor])) })),
    promos: promos.map((p) => ({ id: p.id, kind: p.kind as "percent" | "amount_off", valueBp: p.valueBp, amountMinor: p.amountMinor, variantIds: p.variantIds, minQty: p.minQty, validFrom: d(p.validFrom), validTo: d(p.validTo), stackable: p.stackable })),
    version: Math.max(0, ...books.map((b) => b.version), ...promos.map((p) => p.version)),
  };
}
