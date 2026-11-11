import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { resolveTaxRule } from "@shelfline/pricing";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { category, product, taxClass, taxRate, variant } from "../db/schema";
import { parseCsv, parsePriceMinor } from "./csv";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const pgErr = (e: unknown): { code?: string; constraint?: string } => ((e as { cause?: object })?.cause ?? e ?? {}) as { code?: string; constraint?: string };
const SKU_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BARCODE_RE = /^[A-Za-z0-9]{6,32}$/;
const MAX_IMPORT_ROWS = 20_000;

export interface VariantInput { sku: string; barcode?: string | null; options?: Record<string, string>; basePriceMinor: number; costMinor?: number | null; trackStock?: boolean }
export interface ImportReport { dryRun: boolean; rows: number; imported: { products: number; variants: number }; errors: { line: number; errors: string[] }[] }

@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}

  /** Serialises catalogue writes per organisation and returns the new version to stamp on changed rows. */
  private async bump(tx: Tx, orgId: string): Promise<number> {
    const r = await tx.execute(sql`insert into shelfline.catalog_version (org_id, seq) values (${orgId}, 1)
      on conflict (org_id) do update set seq = shelfline.catalog_version.seq + 1 returning seq`);
    return Number((r.rows[0] as { seq: string | number }).seq);
  }
  async version(orgId: string) {
    const r = await this.db.execute(sql`select seq from shelfline.catalog_version where org_id = ${orgId}`);
    return { seq: r.rows[0] ? Number((r.rows[0] as { seq: string | number }).seq) : 0 };
  }

  // ---------------------------------------------------------------- categories and tax
  async createCategory(orgId: string, actorId: string, name: string, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(category).values({ orgId, name }).returning();
        await this.bump(tx, orgId);
        await this.audit.record({ orgId, actorId, action: "category.create", subjectType: "category", subjectId: row!.id, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { if (pgErr(e).code === "23505") throw new ConflictException({ code: "category_exists" }); throw e; }
  }
  listCategories(orgId: string) { return this.db.select().from(category).where(eq(category.orgId, orgId)).orderBy(asc(category.name)); }

  async createTaxClass(orgId: string, actorId: string, v: { key: string; name: string }, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(taxClass).values({ orgId, ...v }).returning();
        await this.bump(tx, orgId);
        await this.audit.record({ orgId, actorId, action: "tax_class.create", subjectType: "tax_class", subjectId: row!.id, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { if (pgErr(e).code === "23505") throw new ConflictException({ code: "tax_class_exists" }); throw e; }
  }

  async addTaxRate(orgId: string, actorId: string, taxClassId: string, v: { region?: string | null; rateBp: number; inclusive: boolean; validFrom: string; validTo?: string | null }, ip: string | null) {
    const [tc] = await this.db.select().from(taxClass).where(and(eq(taxClass.id, taxClassId), eq(taxClass.orgId, orgId)));
    if (!tc) throw new NotFoundException({ code: "tax_class_not_found" });
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(taxRate).values({ taxClassId, region: v.region ?? null, rateBp: v.rateBp, taxInclusive: v.inclusive, validFrom: v.validFrom, validTo: v.validTo ?? null }).returning();
        await this.bump(tx, orgId);
        await this.audit.record({ orgId, actorId, action: "tax_rate.create", subjectType: "tax_class", subjectId: taxClassId, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { if (pgErr(e).code === "23P01") throw new ConflictException({ code: "tax_rate_overlap" }); throw e; }
  }

  async listTaxClasses(orgId: string) {
    const classes = await this.db.select().from(taxClass).where(eq(taxClass.orgId, orgId)).orderBy(asc(taxClass.key));
    const rates = classes.length ? await this.db.select().from(taxRate).where(inArray(taxRate.taxClassId, classes.map((c) => c.id))).orderBy(asc(taxRate.validFrom)) : [];
    return classes.map((c) => ({ ...c, rates: rates.filter((r) => r.taxClassId === c.id) }));
  }

  async resolveTax(orgId: string, taxClassId: string, region: string | null, onDate: string) {
    const rates = (await this.listTaxClasses(orgId)).find((c) => c.id === taxClassId)?.rates;
    if (!rates) throw new NotFoundException({ code: "tax_class_not_found" });
    const rule = resolveTaxRule(rates.map((r) => ({ region: r.region, rateBp: r.rateBp, taxInclusive: r.taxInclusive, validFrom: r.validFrom, validTo: r.validTo })), region, onDate);
    if (!rule) throw new NotFoundException({ code: "no_tax_rate_in_force" });
    return rule;
  }

  // ---------------------------------------------------------------- products and variants
  private async assertRefs(tx: Tx | Db, orgId: string, taxClassId?: string | null, categoryId?: string | null) {
    if (taxClassId) { const [t] = await tx.select({ id: taxClass.id }).from(taxClass).where(and(eq(taxClass.id, taxClassId), eq(taxClass.orgId, orgId))); if (!t) throw new BadRequestException({ code: "unknown_tax_class" }); }
    if (categoryId) { const [c] = await tx.select({ id: category.id }).from(category).where(and(eq(category.id, categoryId), eq(category.orgId, orgId))); if (!c) throw new BadRequestException({ code: "unknown_category" }); }
  }
  private mapUnique(e: unknown, sku?: string): never {
    const pe = pgErr(e);
    if (pe.code === "23505" && pe.constraint === "variant_org_sku_uq") throw new ConflictException({ code: "sku_exists", sku });
    if (pe.code === "23505" && pe.constraint === "variant_org_barcode_uq") throw new ConflictException({ code: "barcode_exists" });
    throw e;
  }

  async createProduct(orgId: string, actorId: string, v: { title: string; categoryId?: string | null; taxClassId: string; brand?: string | null; variants: VariantInput[] }, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        await this.assertRefs(tx, orgId, v.taxClassId, v.categoryId);
        const seq = await this.bump(tx, orgId);
        const [p] = await tx.insert(product).values({ orgId, title: v.title, categoryId: v.categoryId ?? null, taxClassId: v.taxClassId, brand: v.brand ?? null, version: seq }).returning();
        const vs = v.variants.length ? await tx.insert(variant).values(v.variants.map((x) => ({ orgId, productId: p!.id, sku: x.sku.trim(), barcode: x.barcode ?? null, options: x.options ?? {}, basePriceMinor: x.basePriceMinor, costMinor: x.costMinor ?? null, trackStock: x.trackStock ?? true, version: seq }))).returning() : [];
        await this.audit.record({ orgId, actorId, action: "product.create", subjectType: "product", subjectId: p!.id, after: { ...p, variants: vs.map((x) => ({ id: x.id, sku: x.sku, basePriceMinor: x.basePriceMinor })) }, ip }, tx);
        return { ...p!, variants: vs };
      });
    } catch (e) { return this.mapUnique(e, v.variants.map((x) => x.sku).join(",")); }
  }

  async addVariant(orgId: string, actorId: string, productId: string, x: VariantInput, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [p] = await tx.select({ id: product.id }).from(product).where(and(eq(product.id, productId), eq(product.orgId, orgId)));
        if (!p) throw new NotFoundException({ code: "product_not_found" });
        const seq = await this.bump(tx, orgId);
        const [row] = await tx.insert(variant).values({ orgId, productId, sku: x.sku.trim(), barcode: x.barcode ?? null, options: x.options ?? {}, basePriceMinor: x.basePriceMinor, costMinor: x.costMinor ?? null, trackStock: x.trackStock ?? true, version: seq }).returning();
        await tx.update(product).set({ version: seq, updatedAt: new Date() }).where(eq(product.id, productId));
        await this.audit.record({ orgId, actorId, action: "variant.create", subjectType: "variant", subjectId: row!.id, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { return this.mapUnique(e, x.sku); }
  }

  async updateVariant(orgId: string, actorId: string, id: string, patch: Partial<{ barcode: string | null; options: Record<string, string>; basePriceMinor: number; costMinor: number | null; trackStock: boolean; status: "active" | "archived" }>, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx.select().from(variant).where(and(eq(variant.id, id), eq(variant.orgId, orgId))).for("update");
        if (!before) throw new NotFoundException({ code: "variant_not_found" });
        const seq = await this.bump(tx, orgId);
        const [after] = await tx.update(variant).set({ ...patch, version: seq, updatedAt: new Date() }).where(eq(variant.id, id)).returning();
        await tx.update(product).set({ version: seq, updatedAt: new Date() }).where(eq(product.id, before.productId));
        const priceChanged = patch.basePriceMinor !== undefined && patch.basePriceMinor !== before.basePriceMinor;
        await this.audit.record({ orgId, actorId, action: priceChanged ? "variant.price_change" : "variant.update", subjectType: "variant", subjectId: id, before, after, ip }, tx);
        return after!;
      });
    } catch (e) { return this.mapUnique(e); }
  }

  async updateProduct(orgId: string, actorId: string, id: string, patch: Partial<{ title: string; categoryId: string | null; taxClassId: string; brand: string | null; status: "active" | "archived" }>, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(product).where(and(eq(product.id, id), eq(product.orgId, orgId))).for("update");
      if (!before) throw new NotFoundException({ code: "product_not_found" });
      await this.assertRefs(tx, orgId, patch.taxClassId, patch.categoryId);
      const seq = await this.bump(tx, orgId);
      const [after] = await tx.update(product).set({ ...patch, version: seq, updatedAt: new Date() }).where(eq(product.id, id)).returning();
      await this.audit.record({ orgId, actorId, action: "product.update", subjectType: "product", subjectId: id, before, after, ip }, tx);
      return after!;
    });
  }

  async getProduct(orgId: string, id: string) {
    const [p] = await this.db.select().from(product).where(and(eq(product.id, id), eq(product.orgId, orgId)));
    if (!p) throw new NotFoundException({ code: "product_not_found" });
    const vs = await this.db.select().from(variant).where(eq(variant.productId, id)).orderBy(asc(variant.sku));
    return { ...p, variants: vs };
  }

  /** Keyset pagination on (lower(title), id). `after` is the opaque cursor returned as `next`. */
  async listProducts(orgId: string, o: { q?: string; status?: string; categoryId?: string; limit?: number; after?: string }) {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const conds = [eq(product.orgId, orgId)];
    if (o.status) conds.push(eq(product.status, o.status));
    if (o.categoryId) conds.push(eq(product.categoryId, o.categoryId));
    if (o.q) {
      const like = `%${o.q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(product.title, like), ilike(product.brand, like), sql`exists (select 1 from ${variant} v where v.product_id = ${product.id} and (lower(v.sku) like lower(${like}) or v.barcode = ${o.q}))`)!);
    }
    if (o.after) {
      const [t, i] = JSON.parse(Buffer.from(o.after, "base64url").toString()) as [string, string];
      conds.push(sql`(lower(${product.title}), ${product.id}) > (${t}, ${i}::uuid)`);
    }
    const rows = await this.db.select().from(product).where(and(...conds)).orderBy(sql`lower(${product.title})`, asc(product.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const ids = page.map((p) => p.id);
    const vs = ids.length ? await this.db.select({ productId: variant.productId, price: variant.basePriceMinor }).from(variant).where(inArray(variant.productId, ids)) : [];
    const items = page.map((p) => { const ps = vs.filter((v) => v.productId === p.id).map((v) => v.price); return { ...p, variantCount: ps.length, priceMinMinor: ps.length ? Math.min(...ps) : null, priceMaxMinor: ps.length ? Math.max(...ps) : null }; });
    const last = page[page.length - 1];
    return { items, next: rows.length > limit && last ? Buffer.from(JSON.stringify([last.title.toLowerCase(), last.id])).toString("base64url") : null };
  }

  /** Type-ahead for pickers (purchase order lines): variants whose title, brand, SKU or barcode match, newest titles first by name. */
  async searchVariants(orgId: string, q: string, limit = 20) {
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    return this.db.select({ id: variant.id, sku: variant.sku, barcode: variant.barcode, options: variant.options, basePriceMinor: variant.basePriceMinor, title: product.title, brand: product.brand })
      .from(variant).innerJoin(product, eq(product.id, variant.productId))
      .where(and(eq(variant.orgId, orgId), eq(variant.trackStock, true), eq(product.status, "active"), or(ilike(product.title, like), ilike(product.brand, like), ilike(variant.sku, like), eq(variant.barcode, q))!))
      .orderBy(sql`lower(${product.title})`, asc(variant.sku)).limit(Math.min(Math.max(limit, 1), 50));
  }

  /** Exact lookup used by scanning: by barcode or SKU. */
  async lookup(orgId: string, q: { barcode?: string; sku?: string }) {
    const cond = q.barcode ? eq(variant.barcode, q.barcode) : sql`lower(btrim(${variant.sku})) = lower(btrim(${q.sku ?? ""}))`;
    const [row] = await this.db.select({ v: variant, p: product, tc: taxClass.key }).from(variant).innerJoin(product, eq(product.id, variant.productId)).innerJoin(taxClass, eq(taxClass.id, product.taxClassId)).where(and(eq(variant.orgId, orgId), cond));
    if (!row) throw new NotFoundException({ code: "not_found" });
    return { variant: row.v, product: { id: row.p.id, title: row.p.title, brand: row.p.brand, taxClassId: row.p.taxClassId, taxClassKey: row.tc } };
  }

  // ---------------------------------------------------------------- CSV import
  /**
   * Columns: product_title, brand, category, tax_class, sku, barcode, price, cost, option_<name>... (price in major units, e.g. 219.95).
   * Valid rows are imported in one transaction; invalid rows are reported with their line number and do not stop the rest.
   */
  async importCsv(orgId: string, actorId: string, text: string, dryRun: boolean, ip: string | null): Promise<ImportReport> {
    let table: string[][];
    try { table = parseCsv(text); } catch (e) { throw new BadRequestException({ code: "csv_malformed", message: (e as Error).message }); }
    const header = (table.shift() ?? []).map((h) => h.trim().toLowerCase());
    for (const need of ["product_title", "tax_class", "sku", "price"]) if (!header.includes(need)) throw new BadRequestException({ code: "csv_missing_column", column: need });
    if (table.length > MAX_IMPORT_ROWS) throw new BadRequestException({ code: "csv_too_large", max: MAX_IMPORT_ROWS });
    const col = (r: string[], n: string) => (r[header.indexOf(n)] ?? "").trim();
    const optionCols = header.map((h, i) => [h, i] as const).filter(([h]) => h.startsWith("option_"));

    const [classes, cats] = await Promise.all([
      this.db.select({ id: taxClass.id, key: taxClass.key }).from(taxClass).where(eq(taxClass.orgId, orgId)),
      this.db.select({ id: category.id, name: category.name }).from(category).where(eq(category.orgId, orgId)),
    ]);
    const classByKey = new Map(classes.map((c) => [c.key.toLowerCase(), c.id]));
    const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));

    const skus = table.map((r) => col(r, "sku").toLowerCase()).filter(Boolean);
    const barcodes = table.map((r) => col(r, "barcode")).filter(Boolean);
    const existingSku = new Set<string>(); const existingBar = new Set<string>();
    for (let i = 0; i < skus.length; i += 2000) {
      const chunk = skus.slice(i, i + 2000);
      (await this.db.select({ s: variant.sku }).from(variant).where(and(eq(variant.orgId, orgId), sql`lower(btrim(${variant.sku})) in (${sql.join(chunk.map((s) => sql`${s}`), sql`, `)})`))).forEach((r) => existingSku.add(r.s.trim().toLowerCase()));
    }
    for (let i = 0; i < barcodes.length; i += 2000) {
      const chunk = barcodes.slice(i, i + 2000);
      (await this.db.select({ b: variant.barcode }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.barcode, chunk)))).forEach((r) => existingBar.add(r.b!));
    }

    const errors: ImportReport["errors"] = [];
    const seenSku = new Set<string>(); const seenBar = new Set<string>();
    const good: { title: string; brand: string | null; categoryName: string | null; taxClassId: string; v: VariantInput }[] = [];
    table.forEach((r, idx) => {
      const line = idx + 2; const errs: string[] = [];
      const title = col(r, "product_title"); const sku = col(r, "sku"); const bc = col(r, "barcode");
      const price = parsePriceMinor(col(r, "price")); const costRaw = col(r, "cost"); const cost = costRaw ? parsePriceMinor(costRaw) : null;
      const tcId = classByKey.get(col(r, "tax_class").toLowerCase());
      const catName = col(r, "category");
      if (!title) errs.push("product_title is required"); else if (title.length > 200) errs.push("product_title is too long");
      if (!SKU_RE.test(sku)) errs.push("sku must be 1-64 letters, digits, dot, dash or underscore");
      else if (existingSku.has(sku.toLowerCase())) errs.push("sku already exists");
      else if (seenSku.has(sku.toLowerCase())) errs.push("sku repeated in this file");
      if (bc) { if (!BARCODE_RE.test(bc)) errs.push("barcode must be 6-32 letters or digits"); else if (existingBar.has(bc) || seenBar.has(bc)) errs.push("barcode already used"); }
      if (price === null) errs.push("price must be a number with at most 2 decimals, e.g. 219.95");
      if (costRaw && cost === null) errs.push("cost must be a number with at most 2 decimals");
      if (!tcId) errs.push(`unknown tax_class "${col(r, "tax_class")}"`);
      if (errs.length) { errors.push({ line, errors: errs }); return; }
      seenSku.add(sku.toLowerCase()); if (bc) seenBar.add(bc);
      const options: Record<string, string> = {};
      for (const [h, i] of optionCols) { const val = (r[i] ?? "").trim(); if (val) options[h.slice(7)] = val; }
      good.push({ title, brand: col(r, "brand") || null, categoryName: catName || null, taxClassId: tcId!, v: { sku, barcode: bc || null, options, basePriceMinor: price!, costMinor: cost } });
    });

    const report: ImportReport = { dryRun, rows: table.length, imported: { products: 0, variants: 0 }, errors };
    if (dryRun || good.length === 0) { report.imported = { products: new Set(good.map((g) => `${g.title.toLowerCase()}|${(g.brand ?? "").toLowerCase()}`)).size, variants: good.length }; if (!dryRun) report.imported = { products: 0, variants: 0 }; return report; }

    await this.db.transaction(async (tx) => {
      const seq = await this.bump(tx, orgId);
      for (const name of new Set(good.map((g) => g.categoryName).filter((x): x is string => !!x))) {
        if (!catByName.has(name.toLowerCase())) { const [c] = await tx.insert(category).values({ orgId, name }).onConflictDoNothing().returning(); catByName.set(name.toLowerCase(), c?.id ?? (await tx.select({ id: category.id }).from(category).where(and(eq(category.orgId, orgId), sql`lower(${category.name}) = ${name.toLowerCase()}`)))[0]!.id); }
      }
      const groups = new Map<string, typeof good>();
      for (const g of good) { const k = `${g.title.toLowerCase()}|${(g.brand ?? "").toLowerCase()}|${g.taxClassId}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(g); }
      const existingProducts = await tx.select({ id: product.id, title: product.title, brand: product.brand, taxClassId: product.taxClassId }).from(product).where(eq(product.orgId, orgId));
      const byKey = new Map(existingProducts.map((p) => [`${p.title.toLowerCase()}|${(p.brand ?? "").toLowerCase()}|${p.taxClassId}`, p.id]));
      const newProducts: (typeof product.$inferInsert)[] = []; const keyOrder: string[] = [];
      for (const [k, rows] of groups) if (!byKey.has(k)) { const f = rows[0]!; newProducts.push({ orgId, title: f.title, brand: f.brand, taxClassId: f.taxClassId, categoryId: f.categoryName ? catByName.get(f.categoryName.toLowerCase()) : null, version: seq }); keyOrder.push(k); }
      for (let i = 0; i < newProducts.length; i += 500) {
        const ins = await tx.insert(product).values(newProducts.slice(i, i + 500)).returning({ id: product.id });
        ins.forEach((p, j) => byKey.set(keyOrder[i + j]!, p.id));
      }
      const touched = new Set<string>(); const vrows: (typeof variant.$inferInsert)[] = [];
      for (const [k, rows] of groups) { const pid = byKey.get(k)!; touched.add(pid); for (const g of rows) vrows.push({ orgId, productId: pid, sku: g.v.sku, barcode: g.v.barcode ?? null, options: g.v.options ?? {}, basePriceMinor: g.v.basePriceMinor, costMinor: g.v.costMinor ?? null, trackStock: true, version: seq }); }
      for (let i = 0; i < vrows.length; i += 500) await tx.insert(variant).values(vrows.slice(i, i + 500));
      if (touched.size) await tx.update(product).set({ version: seq, updatedAt: new Date() }).where(inArray(product.id, [...touched]));
      report.imported = { products: newProducts.length, variants: vrows.length };
      await this.audit.record({ orgId, actorId, action: "catalog.import", detail: { rows: table.length, imported: report.imported, rejected: errors.length }, ip }, tx);
    });
    return report;
  }
}
