import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { GiftService } from "./gift.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const amount = z.number().int().min(1).max(1_000_000);
const Issue = z.object({ amountMinor: amount, customerId: uuid.nullable().optional(), expiresOn: ymd.nullable().optional(), note: z.string().max(200).optional(), code: z.string().trim().min(8).max(40).optional() });
const Top = z.object({ amountMinor: amount, idempotencyKey: uuid, note: z.string().max(200).optional() });
const Adjust = z.object({ amountMinor: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "must not be 0"), idempotencyKey: uuid, note: z.string().trim().min(3).max(200) });

@Controller()
export class GiftController {
  constructor(@Inject(GiftService) private g: GiftService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "giftcard:read", target: "any" }) @Get("gift-cards") list(@Req() r: Request, @Query("q") q?: string, @Query("status") status?: string) { return this.g.list(this.o(r), { q, status }); }
  @Auth({ permission: "giftcard:write", target: "any" }) @Post("gift-cards") issue(@Body() b: unknown, @Req() r: Request) { return this.g.issue(this.o(r), this.u(r), parse(Issue, b), r.ip ?? null); }
  /** Till and back office: is this a real card, and what is on it? Cashiers hold catalog:read, which is all a lookup needs. */
  @Auth({ aud: ["admin", "pos"], permission: "catalog:read", target: "any" }) @Get("gift-cards/lookup") lookup(@Query("code") code: string, @Req() r: Request) { return this.g.lookup(this.o(r), parse(z.string().trim().min(8).max(40), code)); }
  @Auth({ permission: "giftcard:read", target: "any" }) @Get("gift-cards/:id") card(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.g.get(this.o(r), id); }
  @Auth({ permission: "giftcard:write", target: "any" }) @Post("gift-cards/:id/topup") @HttpCode(200) topup(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.g.topUp(this.o(r), this.u(r), id, parse(Top, b), r.ip ?? null); }
  @Auth({ permission: "giftcard:write", target: "any" }) @Patch("gift-cards/:id") setStatus(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.g.setStatus(this.o(r), this.u(r), id, parse(z.object({ status: z.enum(["active", "void"]) }), b).status, r.ip ?? null); }

  @Auth({ aud: ["admin", "pos"], permission: "customer:read", target: "any" }) @Get("customers/:id/credit") credit(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.g.credit(this.o(r), id); }
  @Auth({ permission: "giftcard:write", target: "any" }) @Post("customers/:id/credit") @HttpCode(200) adjust(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.g.adjustCredit(this.o(r), this.u(r), id, parse(Adjust, b), r.ip ?? null); }
}
