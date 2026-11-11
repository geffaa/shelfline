import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { CountsService } from "./counts.service";
import { TransfersService } from "./transfers.service";

const uuid = z.string().uuid(); const qty = z.number().int().min(1).max(100_000);
const Transfer = z.object({ fromLocationId: uuid, toLocationId: uuid, note: z.string().max(300).optional(), lines: z.array(z.object({ variantId: uuid, qty })).min(1).max(300) });
const Receive = z.object({ idempotencyKey: uuid, lines: z.array(z.object({ lineId: uuid, qty: z.number().int().min(0).max(100_000) })).max(300).default([]), closeShort: z.boolean().default(false), note: z.string().max(300).optional() });
const Count = z.object({ locationId: uuid, mode: z.enum(["full", "cycle"]), blind: z.boolean().default(true), categoryId: uuid.optional(), variantIds: z.array(uuid).max(500).optional(), note: z.string().max(300).optional() });
const Counts = z.object({ lines: z.array(z.object({ variantId: uuid, countedQty: z.number().int().min(0).max(1_000_000) })).min(1).max(500) });
const Commit = z.object({ uncounted: z.enum(["skip", "zero"]).optional() });

/** Location checks (inventory:write at the right place) are made in the services: a transfer touches two locations. */
@Controller()
export class StockOpsController {
  constructor(@Inject(TransfersService) private t: TransfersService, @Inject(CountsService) private c: CountsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: "any" }) @Get("transfers")
  transfers(@Req() r: Request, @Query("status") status?: string, @Query("locationId") locationId?: string) { return this.t.list(this.o(r), this.u(r), { status, locationId: locationId ? parse(uuid, locationId) : undefined }); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("transfers")
  createTransfer(@Body() b: unknown, @Req() r: Request) { return this.t.create(this.o(r), this.u(r), parse(Transfer, b), r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: "any" }) @Get("transfers/:id")
  transfer(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.get(this.o(r), this.u(r), id); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("transfers/:id/send") @HttpCode(200)
  send(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.send(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "inventory:write", target: "any" }) @Post("transfers/:id/receive") @HttpCode(200)
  receive(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.t.receive(this.o(r), this.u(r), id, parse(Receive, b), r.ip ?? null); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("transfers/:id/cancel") @HttpCode(200)
  cancelTransfer(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.cancel(this.o(r), this.u(r), id, r.ip ?? null); }

  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: "any" }) @Get("stock-counts")
  counts(@Req() r: Request, @Query("status") status?: string, @Query("locationId") locationId?: string) { return this.c.list(this.o(r), this.u(r), { status, locationId: locationId ? parse(uuid, locationId) : undefined }); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("stock-counts")
  createCount(@Body() b: unknown, @Req() r: Request) { return this.c.create(this.o(r), this.u(r), parse(Count, b), r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "inventory:read", target: "any" }) @Get("stock-counts/:id")
  count(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.get(this.o(r), this.u(r), id); }
  @Auth({ aud: ["admin", "pos"], permission: "inventory:write", target: "any" }) @Put("stock-counts/:id/lines") @HttpCode(200)
  setCounts(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.setCounts(this.o(r), this.u(r), id, parse(Counts, b).lines, r.ip ?? null); }
  @Auth({ aud: ["admin", "pos"], permission: "inventory:write", target: "any" }) @Post("stock-counts/:id/submit") @HttpCode(200)
  submit(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.submit(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("stock-counts/:id/reopen") @HttpCode(200)
  reopen(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.reopen(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("stock-counts/:id/commit") @HttpCode(200)
  commit(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.commit(this.o(r), this.u(r), id, parse(Commit, b ?? {}), r.ip ?? null); }
  @Auth({ permission: "inventory:write", target: "any" }) @Post("stock-counts/:id/cancel") @HttpCode(200)
  cancelCount(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.cancel(this.o(r), this.u(r), id, r.ip ?? null); }
}
