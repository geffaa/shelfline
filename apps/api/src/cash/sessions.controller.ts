import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { SessionsService } from "./sessions.service";

@Controller()
export class SessionsController {
  constructor(@Inject(SessionsService) private s: SessionsService) {}

  @Auth({ permission: "cash:read", target: { query: "locationId" } }) @Get("sessions")
  list(@Req() r: Request, @Query("locationId", new ParseUUIDPipe()) locationId: string, @Query("date") date?: string) { return this.s.list(r.principal!.orgId, locationId, date ? parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date) : undefined); }

  @Auth({ permission: "cash:read", target: "any" }) @Get("sessions/:id")
  detail(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string) { return this.s.detail(r.principal!.orgId, r.principal!.userId, id); }

  @Auth({ permission: "cash:approve", target: "any" }) @Post("sessions/:id/review") @HttpCode(204)
  async review(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown) { await this.s.review(r.principal!.orgId, r.principal!.userId, id, parse(z.object({ note: z.string().trim().max(500).default("") }), b).note, r.ip ?? null); }

  @Auth({ aud: ["pos"] }) @Get("pos/sessions/:id")
  posSession(@Req() r: Request, @Param("id", new ParseUUIDPipe()) id: string) { return this.s.posSession(r.principal!.orgId, r.principal!.deviceId, id); }

  @Auth({ aud: ["pos"] }) @Get("pos/sales")
  posSales(@Req() r: Request, @Query("receipt") receipt?: string) { return this.s.posSales(r.principal!.orgId, r.principal!.deviceId, receipt); }
}
