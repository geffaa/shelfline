import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { SsoService } from "./sso.service";

const Config = z.object({ issuer: z.string().url().max(300), clientId: z.string().trim().min(1).max(200), clientSecret: z.string().trim().min(1).max(500).optional(), emailDomains: z.array(z.string().trim().min(1).max(100)).max(20).default([]), enabled: z.boolean().default(true) });
const A = { permission: "sso:manage" as const, target: "org" as const };

@Controller()
export class SsoController {
  constructor(@Inject(SsoService) private s: SsoService) {}
  @Auth(A) @Get("sso") get(@Req() r: Request) { return this.s.get(r.principal!.orgId); }
  @Auth(A) @Put("sso") set(@Body() b: unknown, @Req() r: Request) { return this.s.set(r.principal!.orgId, r.principal!.userId, parse(Config, b), r.ip ?? null); }
  @Auth(A) @Delete("sso") @HttpCode(204) async remove(@Req() r: Request) { await this.s.remove(r.principal!.orgId, r.principal!.userId, r.ip ?? null); }

  @Public() @Get("auth/sso/start") start(@Query("org") org: string, @Query("hint") hint?: string) { return this.s.start(parse(z.string().min(2).max(40), org), hint ? parse(z.string().email(), hint) : undefined); }
  @Public() @Get("auth/sso/callback") async callback(@Query() q: Record<string, string>, @Req() r: Request, @Res() res: Response) { res.redirect(302, await this.s.callback({ code: q.code, state: q.state, error: q.error }, r.ip ?? null)); }
  @Public() @Post("auth/sso/exchange") @HttpCode(200) exchange(@Body() b: unknown, @Req() r: Request) { return this.s.exchange(parse(z.object({ ticket: z.string().uuid() }), b).ticket, r.ip ?? null); }
}
