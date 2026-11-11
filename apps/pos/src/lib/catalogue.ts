import { applyPromotions, resolvePrice, resolveTaxRule, type BookView, type PromoLine, type PromoResult, type PromoView, type RateRow, type ResolvedPrice, type TaxRule } from "@shelfline/pricing";
import type { LocalStore } from "@shelfline/sync-client";

export interface VariantView { id: string; sku: string; barcode: string | null; productId: string; title: string; brand: string | null; optionsLabel: string; basePriceMinor: number; trackStock: boolean; onHand: number | null; taxClassId: string; status: string }
export interface LocationInfo { id: string; code: string; name: string; timezone: string; dayCutoff: string; taxRegion: string | null; cashierDiscountLimitBp: number; cashierRefundLimitMinor: number; cashVarianceLimitMinor: number; giftCardOffline?: boolean; giftCardOfflineCapMinor?: number }
export interface CustomerView { id: string; name: string; email: string | null; phone: string | null }

type R = Record<string, any>;
/** In-memory index over the replica (a few thousand variants). Rebuilt after each sync. */
export class Catalogue {
  variants = new Map<string, VariantView>(); private byBarcode = new Map<string, string>(); private bySku = new Map<string, string>();
  customers: CustomerView[] = []; location: LocationInfo | null = null; register: { id: string; code: string; name: string } | null = null;
  books: BookView[] = []; promos: PromoView[] = []; pricingVersion = 0;
  private rates = new Map<string, RateRow[]>(); private searchText = new Map<string, string>();

  /** `registerId` is this iPad's own register: the replica carries every register of the store, and only one of them is ours. */
  static async load(store: LocalStore, pendingSold: Map<string, number> = new Map(), registerId: string | null = null): Promise<Catalogue> {
    const c = new Catalogue();
    const [products, variants, rates, stock, customers, locs, regs, books, entries, promos] = await Promise.all(["product", "variant", "tax_rate", "stock_balance", "customer", "location", "register", "price_book", "price_book_entry", "promotion"].map((t) => store.list<R>(`replica:${t}`)));
    const prod = new Map(products!.map((p) => [p.key, p.value]));
    const onHand = new Map(stock!.map((s) => [s.value.variantId as string, s.value.onHand as number]));
    for (const { value: v } of variants!) {
      const p = prod.get(v.productId); if (!p) continue;
      const opts = Object.values((v.options ?? {}) as Record<string, string>).join(" · ");
      const view: VariantView = { id: v.id, sku: v.sku, barcode: v.barcode, productId: v.productId, title: p.title, brand: p.brand, optionsLabel: opts, basePriceMinor: v.basePriceMinor, trackStock: v.trackStock, taxClassId: p.taxClassId, status: v.status,
        onHand: v.trackStock ? (onHand.get(v.id) ?? 0) - (pendingSold.get(v.id) ?? 0) : null };
      c.variants.set(v.id, view); if (v.barcode) c.byBarcode.set(v.barcode, v.id); c.bySku.set(String(v.sku).toLowerCase(), v.id);
      c.searchText.set(v.id, `${p.title} ${p.brand ?? ""} ${v.sku} ${opts}`.toLowerCase());
    }
    for (const { value: r } of rates!) { const l = c.rates.get(r.taxClassId) ?? []; l.push({ region: r.region, rateBp: r.rateBp, taxInclusive: r.inclusive, validFrom: r.validFrom, validTo: r.validTo }); c.rates.set(r.taxClassId, l); }
    c.customers = customers!.map((x) => ({ id: x.key, ...(x.value as { name: string; email: string | null; phone: string | null }) })).sort((a, b) => a.name.localeCompare(b.name));
    c.location = (locs![0]?.value as LocationInfo | undefined) ?? null; const mine = regs!.find((r) => (r.value as { id: string }).id === registerId) ?? (registerId ? undefined : regs![0]); c.register = (mine?.value as { id: string; code: string; name: string } | undefined) ?? null;
    // price books and promotions as last synced; entries of a book this till does not hold are ignored
    const bookIds = new Set(books!.map((b) => b.key)); const prices = new Map<string, Record<string, number>>();
    for (const { value: e } of entries!) { if (!bookIds.has(e.bookId)) continue; const m = prices.get(e.bookId) ?? {}; m[e.variantId] = e.priceMinor; prices.set(e.bookId, m); }
    c.books = books!.map(({ value: b }) => ({ id: b.id, priority: b.priority, validFrom: b.validFrom, validTo: b.validTo, prices: prices.get(b.id) ?? {} }));
    c.promos = promos!.map(({ value: p }) => ({ id: p.id, kind: p.kind, valueBp: p.valueBp, amountMinor: p.amountMinor, variantIds: p.variantIds, minQty: p.minQty, validFrom: p.validFrom, validTo: p.validTo, stackable: p.stackable }));
    c.pricingVersion = Math.max(0, ...books!.map((b) => b.value.version as number), ...promos!.map((p) => p.value.version as number));
    return c;
  }

  /** The price this variant sells at today at this location: the winning price book, or the catalogue price. Runs offline on the last synced books. */
  priceFor(variantId: string, localDate: string): ResolvedPrice { return resolvePrice(variantId, this.variants.get(variantId)?.basePriceMinor ?? 0, localDate, this.books); }
  promotionsFor(lines: PromoLine[], localDate: string): PromoResult[] { return applyPromotions(lines, this.promos, localDate); }

  byCode(code: string): VariantView | undefined { const id = this.byBarcode.get(code.trim()) ?? this.bySku.get(code.trim().toLowerCase()); return id ? this.variants.get(id) : undefined; }

  /** Every word must appear; exact SKU/barcode first, then titles that start with the first word. Archived variants are hidden. */
  search(q: string, limit = 40): VariantView[] {
    const exact = this.byCode(q); const words = q.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return [];
    const hits: { v: VariantView; rank: number }[] = [];
    for (const [id, text] of this.searchText) { const v = this.variants.get(id)!; if (v.status !== "active") continue; if (!words.every((w) => text.includes(w))) continue; hits.push({ v, rank: (v.id === exact?.id ? 0 : v.title.toLowerCase().startsWith(words[0]!) ? 1 : 2) }); }
    return hits.sort((a, b) => a.rank - b.rank || a.v.title.localeCompare(b.v.title) || a.v.sku.localeCompare(b.v.sku)).slice(0, limit).map((h) => h.v);
  }

  taxRuleFor(variantId: string, localDate: string): TaxRule {
    const v = this.variants.get(variantId);
    return (v && resolveTaxRule(this.rates.get(v.taxClassId) ?? [], this.location?.taxRegion ?? null, localDate)) || { rateBp: 0, inclusive: true };
  }
  searchCustomers(q: string, limit = 20): CustomerView[] { const s = q.toLowerCase().trim(); if (!s) return this.customers.slice(0, limit); return this.customers.filter((c) => `${c.name} ${c.email ?? ""} ${c.phone ?? ""}`.toLowerCase().includes(s)).slice(0, limit); }
}
