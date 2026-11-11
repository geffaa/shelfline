import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { ReplenishmentService } from "./replenishment.service";

const uuid = z.string().uuid(); const num = (a: number, b: number, d: number) => z.coerce.number().int().min(a).max(b).default(d);
const Q = z.object({ locationId: uuid, scope: z.enum(["location", "network"]).default("location"), lookbackDays: num(7, 180, 30), safetyDays: num(0, 60, 3), reviewDays: num(0, 90, 14) });
const Draft = z.object({ locationId: uuid, key: uuid, lines: z.array(z.object({ variantId: uuid, supplierId: uuid, qty: z.number().int().min(1).max(100_000), unitCostMinor: z.number().int().min(0).max(1_000_000_000) })).min(1).max(500) });

@Controller("replenishment")
export class ReplenishmentController {
  constructor(@Inject(ReplenishmentService) private s: ReplenishmentService) {}
  @Auth({ permission: "purchase:read", target: "org" }) @Get() suggestions(@Query() q: unknown, @Req() r: Request) { return this.s.suggestions(r.principal!.orgId, parse(Q, q)); }
  @Auth({ permission: "purchase:write", target: "org" }) @Post("draft-pos") @HttpCode(200) draft(@Body() b: unknown, @Req() r: Request) { return this.s.draft(r.principal!.orgId, r.principal!.userId, parse(Draft, b), r.ip ?? null); }
}
