import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { CardsService } from "./cards.service";

const uuid = z.string().uuid();
const Reader = z.object({ locationId: uuid, registerId: uuid.nullable().optional(), name: z.string().trim().min(1).max(60), providerReaderId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/), active: z.boolean().default(true) });
const ReaderPatch = z.object({ registerId: uuid.nullable(), name: z.string().trim().min(1).max(60), providerReaderId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/), active: z.boolean() }).partial().strict();
const Start = z.object({ amountMinor: z.number().int().min(1).max(10_000_000), idempotencyKey: uuid });

@Controller()
export class CardsController {
  constructor(@Inject(CardsService) private c: CardsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Auth({ permission: "device:manage", target: "any" }) @Get("card-readers") readers(@Req() r: Request) { return this.c.listReaders(this.o(r), this.u(r)); }
  @Auth({ permission: "device:manage", target: { body: "locationId" } }) @Post("card-readers") create(@Body() b: unknown, @Req() r: Request) { return this.c.createReader(this.o(r), this.u(r), parse(Reader, b) as never, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "any" }) @Patch("card-readers/:id") patch(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.updateReader(this.o(r), this.u(r), id, parse(ReaderPatch, b) as never, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "any" }) @Get("card-payments") payments(@Req() r: Request) { return this.c.payments(this.o(r), this.u(r)); }

  @Auth({ aud: ["pos"] }) @Post("pos/card/start") @HttpCode(200) start(@Body() b: unknown, @Req() r: Request) { return this.c.start(this.o(r), this.u(r), r.principal!.deviceId!, parse(Start, b)); }
  @Auth({ aud: ["pos"] }) @Get("pos/card/:id") get(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.get(this.o(r), r.principal!.deviceId!, id); }
  @Auth({ aud: ["pos"] }) @Post("pos/card/:id/cancel") @HttpCode(200) cancel(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.cancel(this.o(r), r.principal!.deviceId!, id); }
}
