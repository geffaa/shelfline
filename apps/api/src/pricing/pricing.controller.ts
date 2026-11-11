import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { PricingService } from "./pricing.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const money = z.number().int().min(0).max(100_000_000);
const window = (o: { validFrom?: string | null; validTo?: string | null }) => !o.validFrom || !o.validTo || o.validFrom <= o.validTo;
const Book = z.object({ name: z.string().trim().min(1).max(100), priority: z.number().int().min(0).max(1000).default(100), validFrom: ymd.nullable().default(null), validTo: ymd.nullable().default(null), locationIds: z.array(uuid).max(100).default([]) }).refine(window, { message: "valid_to before valid_from", path: ["validTo"] });
const BookPatch = z.object({ name: z.string().trim().min(1).max(100), priority: z.number().int().min(0).max(1000), validFrom: ymd.nullable(), validTo: ymd.nullable(), locationIds: z.array(uuid).max(100), status: z.enum(["active", "archived"]) }).partial().refine((o) => Object.keys(o).length > 0 && window(o), "nothing to change, or valid_to before valid_from");
const Entries = z.object({ set: z.array(z.object({ variantId: uuid, priceMinor: money })).max(1000).default([]), remove: z.array(uuid).max(1000).default([]) }).refine((o) => o.set.length + o.remove.length > 0, "nothing to change");
const Promo = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(["percent", "amount_off"]), valueBp: z.number().int().min(0).max(10000).default(0), amountMinor: money.default(0), minQty: z.number().int().min(1).max(999).default(1), stackable: z.boolean().default(false),
  validFrom: ymd.nullable().default(null), validTo: ymd.nullable().default(null), variantIds: z.array(uuid).max(1000).default([]), locationIds: z.array(uuid).max(100).default([]) })
  .refine(window, { message: "valid_to before valid_from", path: ["validTo"] }).refine((o) => (o.kind === "percent" ? o.valueBp >= 1 && o.amountMinor === 0 : o.amountMinor >= 1 && o.valueBp === 0), { message: "percent needs value_bp, amount_off needs amount_minor", path: ["kind"] });
const PromoPatch = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(["percent", "amount_off"]), valueBp: z.number().int().min(0).max(10000), amountMinor: money, minQty: z.number().int().min(1).max(999), stackable: z.boolean(), validFrom: ymd.nullable(), validTo: ymd.nullable(), variantIds: z.array(uuid).max(1000), locationIds: z.array(uuid).max(100), status: z.enum(["active", "archived"]) }).partial().refine((o) => Object.keys(o).length > 0 && window(o), "nothing to change, or valid_to before valid_from");
const Preview = z.object({ variantId: uuid, locationId: uuid, onDate: ymd, qty: z.coerce.number().int().min(1).max(999).default(1) });

@Controller()
export class PricingController {
  constructor(@Inject(PricingService) private p: PricingService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "pricing:read", target: "org" }) @Get("price-books") books(@Req() r: Request) { return this.p.listBooks(this.o(r)); }
  @Auth({ permission: "pricing:write", target: "org" }) @Post("price-books") createBook(@Body() b: unknown, @Req() r: Request) { return this.p.createBook(this.o(r), this.u(r), parse(Book, b), r.ip ?? null); }
  @Auth({ permission: "pricing:read", target: "org" }) @Get("price-books/:id") book(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.getBook(this.o(r), id); }
  @Auth({ permission: "pricing:write", target: "org" }) @Patch("price-books/:id") patchBook(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.p.updateBook(this.o(r), this.u(r), id, parse(BookPatch, b), r.ip ?? null); }
  @Auth({ permission: "pricing:write", target: "org" }) @Put("price-books/:id/entries") @HttpCode(200) entries(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.p.setEntries(this.o(r), this.u(r), id, parse(Entries, b), r.ip ?? null); }

  @Auth({ permission: "pricing:read", target: "org" }) @Get("promotions") promos(@Req() r: Request) { return this.p.listPromos(this.o(r)); }
  @Auth({ permission: "pricing:write", target: "org" }) @Post("promotions") createPromo(@Body() b: unknown, @Req() r: Request) { return this.p.createPromo(this.o(r), this.u(r), parse(Promo, b), r.ip ?? null); }
  @Auth({ permission: "pricing:read", target: "org" }) @Get("promotions/:id") promo(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.getPromo(this.o(r), id); }
  @Auth({ permission: "pricing:write", target: "org" }) @Patch("promotions/:id") patchPromo(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.p.updatePromo(this.o(r), this.u(r), id, parse(PromoPatch, b), r.ip ?? null); }
  @Auth({ permission: "pricing:read", target: "org" }) @Get("pricing/preview") preview(@Query() q: unknown, @Req() r: Request) { return this.p.preview(this.o(r), parse(Preview, q)); }
}
