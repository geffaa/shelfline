import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { ACCOUNT_KEYS } from "../db/schema";
import { AccountingService } from "./accounting.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Mappings = z.object({ items: z.array(z.object({ key: z.enum(ACCOUNT_KEYS), code: z.string().trim().min(1).max(20), name: z.string().trim().max(80).nullable().optional() })).min(1).max(20) });
const Xero = z.object({ tenantId: z.string().trim().min(8).max(80), accessToken: z.string().trim().min(8).max(4000), refreshToken: z.string().trim().min(8).max(500), clientId: z.string().trim().min(4).max(100), clientSecret: z.string().trim().min(4).max(200) });
const A = { permission: "accounting:manage" as const, target: "org" as const };

@Controller("accounting")
export class AccountingController {
  constructor(@Inject(AccountingService) private a: AccountingService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Auth(A) @Get("accounts") accounts(@Req() r: Request) { return this.a.mappings(this.o(r)); }
  @Auth(A) @Put("accounts") setAccounts(@Body() b: unknown, @Req() r: Request) { return this.a.setMappings(this.o(r), this.u(r), parse(Mappings, b).items, r.ip ?? null); }
  @Auth(A) @Get("days") days(@Query("locationId") l: string, @Query("from") from: string, @Query("to") to: string, @Req() r: Request) { return this.a.days(this.o(r), { locationId: parse(uuid, l), from: parse(ymd, from), to: parse(ymd, to) }); }
  @Auth(A) @Get("day") day(@Query("locationId") l: string, @Query("date") d: string, @Req() r: Request) { return this.a.day(this.o(r), parse(uuid, l), parse(ymd, d)); }
  @Auth(A) @Post("export") @HttpCode(200) export(@Body() b: unknown, @Req() r: Request) { return this.a.export(this.o(r), this.u(r), parse(z.object({ locationId: uuid, date: ymd, method: z.enum(["xero", "csv"]) }), b), r.ip ?? null); }
  @Auth(A) @Get("exports") history(@Req() r: Request) { return this.a.history(this.o(r)); }
  @Auth(A) @Get("exports/:id/csv") @Header("content-type", "text/csv; charset=utf-8") async csv(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) { const x = await this.a.csvFor(this.o(r), id); res.setHeader("content-disposition", `attachment; filename="${x.name}"`); return x.csv; }
  @Auth(A) @Get("xero") xero(@Req() r: Request) { return this.a.xeroStatus(this.o(r)); }
  @Auth(A) @Put("xero") connect(@Body() b: unknown, @Req() r: Request) { return this.a.connectXero(this.o(r), this.u(r), parse(Xero, b), r.ip ?? null); }
  @Auth(A) @Delete("xero") disconnect(@Req() r: Request) { return this.a.disconnectXero(this.o(r), this.u(r), r.ip ?? null); }
}
