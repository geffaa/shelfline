import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { TerminalsService } from "../terminals/terminals.service";
import { PrintingService, validHost } from "./printing.service";

const uuid = z.string().uuid(); const host = z.string().trim().min(1).max(253).refine(validHost, "not a host name or address");
const Printer = z.object({ locationId: uuid, registerId: uuid.nullable().optional(), name: z.string().trim().min(1).max(60), host, port: z.number().int().min(1).max(65535).default(9100), columns: z.number().int().min(24).max(64).default(42), active: z.boolean().default(true) });
const PrinterPatch = z.object({ registerId: uuid.nullable(), name: z.string().trim().min(1).max(60), host, port: z.number().int().min(1).max(65535), columns: z.number().int().min(24).max(64), active: z.boolean() }).partial().strict();
const PosPrint = z.discriminatedUnion("kind", [z.object({ kind: z.literal("receipt"), saleId: uuid }), z.object({ kind: z.literal("drawer"), reason: z.enum(["cash_sale", "no_sale", "manual"]).default("manual") })]);

@Controller()
export class PrintingController {
  constructor(@Inject(PrintingService) private p: PrintingService, @Inject(TerminalsService) private t: TerminalsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  // back office
  @Auth({ permission: "device:manage", target: "any" }) @Get("printers") list(@Req() r: Request) { return this.p.list(this.o(r), this.u(r)); }
  @Auth({ permission: "device:manage", target: { body: "locationId" } }) @Post("printers") create(@Body() b: unknown, @Req() r: Request) { return this.p.create(this.o(r), this.u(r), parse(Printer, b) as never, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "any" }) @Patch("printers/:id") patch(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.p.update(this.o(r), this.u(r), id, parse(PrinterPatch, b) as never, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "any" }) @Post("printers/:id/test") @HttpCode(200) test(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.testPrint(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "any" }) @Get("print-jobs") jobs(@Req() r: Request, @Query("locationId") locationId?: string) { return this.p.jobs(this.o(r), this.u(r), locationId ? parse(uuid, locationId) : undefined); }
  @Auth({ permission: "device:manage", target: "any" }) @Post("print-jobs/:id/retry") @HttpCode(200) retry(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.p.retry(this.o(r), this.u(r), id, r.ip ?? null); }

  // the till
  @Auth({ aud: ["pos"] }) @Post("pos/print") @HttpCode(200)
  print(@Body() b: unknown, @Req() r: Request) { const v = parse(PosPrint, b); const dev = r.principal!.deviceId!; return v.kind === "receipt" ? this.p.printReceipt(this.o(r), this.u(r), dev, v.saleId) : this.p.openDrawer(this.o(r), this.u(r), dev, v.reason); }

  // the bridge (signed, like attendance batches)
  @Public() @Post("devices/print-jobs/claim") @HttpCode(200)
  async claim(@Req() r: Request & { rawBody?: Buffer }, @Headers("x-bridge-id") id?: string, @Headers("x-timestamp") ts?: string, @Headers("x-signature") sig?: string) {
    const b = await this.t.authenticate(id, ts, sig, r.rawBody); return this.p.claim(b, parse(z.object({ max: z.number().int().min(1).max(20).default(5) }), r.body ?? {}).max);
  }
  @Public() @Post("devices/print-jobs/result") @HttpCode(200)
  async result(@Req() r: Request & { rawBody?: Buffer }, @Headers("x-bridge-id") id?: string, @Headers("x-timestamp") ts?: string, @Headers("x-signature") sig?: string) {
    const b = await this.t.authenticate(id, ts, sig, r.rawBody); const v = parse(z.object({ id: uuid, ok: z.boolean(), error: z.string().max(300).optional() }), r.body); return this.p.result(b, v.id, v.ok, v.error);
  }
}
