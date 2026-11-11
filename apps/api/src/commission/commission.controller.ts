import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { COMMISSION_BASES, COMMISSION_SCOPES, COMMISSION_SPLITS } from "../db/schema";
import { CommissionService } from "./commission.service";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Rule = z.object({
  scopeKind: z.enum(COMMISSION_SCOPES), scopeValue: z.string().trim().min(1).max(120).nullable().optional(), validFrom: ymd, enabled: z.boolean().default(true),
  basis: z.enum(COMMISSION_BASES), rateBp: z.number().int().min(0).max(10_000), splitMode: z.enum(COMMISSION_SPLITS),
  weights: z.record(z.string().max(60), z.number().int().min(0).max(10_000)).default({}), note: z.string().trim().max(300).optional(),
});
const Preview = z.object({ variantId: z.string().uuid(), locationId: z.string().uuid(), date: ymd, qty: z.number().int().min(1).max(10_000).default(1), totalMinor: z.number().int().min(0).max(100_000_000) });
const Period = z.object({ from: ymd, to: ymd });
const Adjust = z.object({ userId: z.string().uuid(), amountMinor: z.number().int().min(-10_000_000).max(10_000_000), reason: z.string().trim().min(3).max(300) });

@Controller("commission")
export class CommissionController {
  constructor(@Inject(CommissionService) private c: CommissionService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "commission:read", target: "org" }) @Get("rules")
  rules(@Req() r: Request) { return this.c.listRules(this.o(r)); }
  @Auth({ permission: "commission:write", target: "org" }) @Post("rules")
  addRule(@Body() b: unknown, @Req() r: Request) { return this.c.addVersion(this.o(r), this.u(r), parse(Rule, b), r.ip ?? null); }
  @Auth({ permission: "commission:read", target: "org" }) @Post("preview") @HttpCode(200)
  preview(@Body() b: unknown, @Req() r: Request) { return this.c.preview(this.o(r), parse(Preview, b)); }

  @Auth({ permission: "commission:read", target: "org" }) @Get("periods")
  periods(@Req() r: Request) { return this.c.listPeriods(this.o(r)); }
  @Auth({ permission: "commission:write", target: "org" }) @Post("periods")
  createPeriod(@Body() b: unknown, @Req() r: Request) { return this.c.createPeriod(this.o(r), this.u(r), parse(Period, b), r.ip ?? null); }
  @Auth({ permission: "commission:lock", target: "org" }) @Post("periods/:id/lock") @HttpCode(200)
  lock(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.lock(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "commission:read", target: "org" }) @Get("periods/:id/statements")
  statements(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.statements(this.o(r), id); }
  @Auth({ permission: "commission:read", target: "org" }) @Get("periods/:id/statements/:userId")
  detail(@Param("id", new ParseUUIDPipe()) id: string, @Param("userId", new ParseUUIDPipe()) userId: string, @Req() r: Request) { return this.c.detail(this.o(r), id, userId); }
  @Auth({ permission: "commission:read", target: "org" }) @Get("periods/:id/export")
  async csv(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request, @Res({ passthrough: true }) res: Response, @Query("format") _f?: string) {
    const x = await this.c.csv(this.o(r), id); res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="${x.name}"`); return x.csv;
  }
  @Auth({ permission: "commission:write", target: "org" }) @Post("adjustments")
  adjust(@Body() b: unknown, @Req() r: Request) { return this.c.adjust(this.o(r), this.u(r), parse(Adjust, b), r.ip ?? null); }
  @Auth({ permission: "commission:write", target: "org" }) @Post("recalculate") @HttpCode(200)
  recalc(@Req() r: Request) { return this.c.recalculate(this.o(r)); }
}
