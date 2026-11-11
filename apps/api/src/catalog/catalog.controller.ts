import { BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { CatalogService } from "./catalog.service";

const money = z.number().int().min(0).max(100_000_000);
const sku = z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/, "1-64 letters, digits, dot, dash or underscore");
const barcode = z.string().regex(/^[A-Za-z0-9]{6,32}$/, "6-32 letters or digits");
const options = z.record(z.string().min(1).max(32), z.string().min(1).max(64)).refine((o) => Object.keys(o).length <= 4, "at most 4 options");
const Variant = z.object({ sku, barcode: barcode.nullish(), options: options.optional(), basePriceMinor: money, costMinor: money.nullish(), trackStock: z.boolean().optional() });
const NewProduct = z.object({ title: z.string().trim().min(1).max(200), categoryId: z.string().uuid().nullish(), taxClassId: z.string().uuid(), brand: z.string().trim().max(80).nullish(), variants: z.array(Variant).max(200).default([]) })
  .refine((p) => new Set(p.variants.map((v) => v.sku.toLowerCase())).size === p.variants.length, { message: "duplicate sku in request", path: ["variants"] });
const PatchProduct = z.object({ title: z.string().trim().min(1).max(200), categoryId: z.string().uuid().nullable(), taxClassId: z.string().uuid(), brand: z.string().trim().max(80).nullable(), status: z.enum(["active", "archived"]) }).partial().refine((o) => Object.keys(o).length > 0, "empty patch");
const PatchVariant = z.object({ barcode: barcode.nullable(), options, basePriceMinor: money, costMinor: money.nullable(), trackStock: z.boolean(), status: z.enum(["active", "archived"]) }).partial().refine((o) => Object.keys(o).length > 0, "empty patch");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NewRate = z.object({ region: z.string().max(32).nullish(), rateBp: z.number().int().min(0).max(10000), inclusive: z.boolean(), validFrom: date, validTo: date.nullish() });

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private c: CatalogService) {}
  private o = (r: Request) => r.principal!.orgId;
  private u = (r: Request) => r.principal!.userId;

  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("catalog/version")
  version(@Req() r: Request) { return this.c.version(this.o(r)); }

  @Auth({ permission: "catalog:write", target: "org" }) @Post("categories")
  createCategory(@Body() b: unknown, @Req() r: Request) { return this.c.createCategory(this.o(r), this.u(r), parse(z.object({ name: z.string().trim().min(1).max(80) }), b).name, r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("categories")
  categories(@Req() r: Request) { return this.c.listCategories(this.o(r)); }

  @Auth({ permission: "catalog:write", target: "org" }) @Post("tax-classes")
  createTaxClass(@Body() b: unknown, @Req() r: Request) { return this.c.createTaxClass(this.o(r), this.u(r), parse(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), name: z.string().trim().min(1).max(80) }), b), r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("tax-classes")
  taxClasses(@Req() r: Request) { return this.c.listTaxClasses(this.o(r)); }
  @Auth({ permission: "catalog:write", target: "org" }) @Post("tax-classes/:id/rates")
  addRate(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.addTaxRate(this.o(r), this.u(r), id, parse(NewRate, b), r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("tax-classes/:id/resolve")
  resolve(@Param("id", new ParseUUIDPipe()) id: string, @Query("date") d: string, @Query("region") region: string | undefined, @Req() r: Request) {
    return this.c.resolveTax(this.o(r), id, region ?? null, parse(date, d));
  }

  @Auth({ permission: "catalog:write", target: "org" }) @Post("products")
  createProduct(@Body() b: unknown, @Req() r: Request) { return this.c.createProduct(this.o(r), this.u(r), parse(NewProduct, b), r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("products")
  products(@Req() r: Request, @Query("q") q?: string, @Query("status") status?: string, @Query("categoryId") categoryId?: string, @Query("limit") limit?: string, @Query("after") after?: string) {
    return this.c.listProducts(this.o(r), { q, status, categoryId, limit: limit ? Number(limit) : undefined, after });
  }
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("products/:id")
  product(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.getProduct(this.o(r), id); }
  @Auth({ permission: "catalog:write", target: "org" }) @Patch("products/:id")
  patchProduct(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.updateProduct(this.o(r), this.u(r), id, parse(PatchProduct, b), r.ip ?? null); }
  @Auth({ permission: "catalog:write", target: "org" }) @Post("products/:id/variants")
  addVariant(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.addVariant(this.o(r), this.u(r), id, parse(Variant, b), r.ip ?? null); }
  @Auth({ permission: "catalog:write", target: "org" }) @Patch("variants/:id")
  patchVariant(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.updateVariant(this.o(r), this.u(r), id, parse(PatchVariant, b), r.ip ?? null); }
  @Auth({ permission: "catalog:read", target: "any" }) @Get("variants/search")
  searchVariants(@Req() r: Request, @Query("q") q = "", @Query("limit") limit?: string) { return q.trim().length < 2 ? [] : this.c.searchVariants(this.o(r), q.trim(), limit ? Number(limit) : undefined); }

  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("variants/lookup")
  lookup(@Req() r: Request, @Query("barcode") bc?: string, @Query("sku") sku?: string) {
    if (!bc && !sku) throw new BadRequestException({ code: "barcode_or_sku_required" });
    return this.c.lookup(this.o(r), { barcode: bc, sku });
  }

  /** Body: raw CSV (Content-Type: text/csv). `?dryRun=true` validates without writing. */
  @Auth({ permission: "catalog:write", target: "org" }) @Post("catalog/import")
  import(@Body() body: unknown, @Query("dryRun") dry: string | undefined, @Req() r: Request) {
    if (typeof body !== "string" || !body.trim()) throw new BadRequestException({ code: "csv_required", message: "send the CSV as the request body with Content-Type: text/csv" });
    return this.c.importCsv(this.o(r), this.u(r), body, dry === "true", r.ip ?? null);
  }
}
