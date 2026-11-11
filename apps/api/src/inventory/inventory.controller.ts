import { Body, Controller, Get, HttpCode, Inject, ParseUUIDPipe, Post, Query, Req, Param } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { ADJUST_REASONS, InventoryService } from "./inventory.service";

const uuid = z.string().uuid();
const Receive = z.object({ locationId: uuid, reference: z.string().max(80).optional(), idempotencyKey: uuid,
  lines: z.array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(100_000), unitCostMinor: z.number().int().min(0).max(100_000_000) })).min(1).max(500) })
  .refine((v) => new Set(v.lines.map((l) => l.variantId)).size === v.lines.length, { message: "a variant may appear once per receipt", path: ["lines"] });
const Adjust = z.object({ locationId: uuid, variantId: uuid, qtyDelta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, "must not be 0"), reason: z.enum(ADJUST_REASONS), note: z.string().max(300).optional(), idempotencyKey: uuid });

@Controller()
export class InventoryController {
  constructor(@Inject(InventoryService) private inv: InventoryService) {}

  @Auth({ permission: "inventory:write", target: { body: "locationId" } }) @Post("inventory/receive") @HttpCode(200)
  receive(@Body() b: unknown, @Req() r: Request) { return this.inv.receive(r.principal!.orgId, r.principal!.userId, parse(Receive, b), r.ip ?? null); }

  @Auth({ permission: "inventory:write", target: { body: "locationId" } }) @Post("inventory/adjust") @HttpCode(200)
  adjust(@Body() b: unknown, @Req() r: Request) { return this.inv.adjust(r.principal!.orgId, r.principal!.userId, parse(Adjust, b), r.ip ?? null); }

  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: "any" }) @Get("inventory")
  list(@Req() r: Request, @Query("locationId") locationId?: string, @Query("variantId") variantId?: string, @Query("q") q?: string) {
    return this.inv.list(r.principal!.orgId, r.principal!.userId, { locationId: locationId ? parse(uuid, locationId) : undefined, variantId: variantId ? parse(uuid, variantId) : undefined, q });
  }

  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: { query: "locationId" } }) @Get("inventory/:variantId/ledger")
  card(@Param("variantId", new ParseUUIDPipe()) variantId: string, @Query("locationId", new ParseUUIDPipe()) locationId: string, @Req() r: Request) {
    return this.inv.card(r.principal!.orgId, r.principal!.userId, variantId, locationId);
  }

  @Auth({ permission: "inventory:write", target: "org" }) @Get("inventory-check")
  check(@Req() r: Request) { return this.inv.check(r.principal!.orgId).then((mismatches) => ({ ok: mismatches.length === 0, mismatches })); }
}
