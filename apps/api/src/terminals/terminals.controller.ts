import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { TerminalsService } from "./terminals.service";

const uuid = z.string().uuid();
const Event = z.object({ serial: z.string().trim().min(1).max(40), personCode: z.string().trim().min(1).max(40), ts: z.string().datetime({ offset: true }), verify: z.enum(["fingerprint", "face", "card", "password", "other"]), state: z.enum(["in", "out"]).nullable().optional() });
const Batch = z.object({ events: z.array(Event).min(1).max(500) });

@Controller()
export class TerminalsController {
  constructor(@Inject(TerminalsService) private t: TerminalsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  // ---- the bridge (no user: a short pairing code once, then signed batches)
  @Public() @Post("devices/pair") @HttpCode(200)
  pair(@Body() b: unknown) { return this.t.pair(parse(z.object({ pairingCode: z.string().min(6).max(20) }), b).pairingCode); }
  @Public() @Post("devices/punches") @HttpCode(200)
  async punches(@Req() r: Request & { rawBody?: Buffer }, @Headers("x-bridge-id") id?: string, @Headers("x-timestamp") ts?: string, @Headers("x-signature") sig?: string) {
    const b = await this.t.authenticate(id, ts, sig, r.rawBody); const v = parse(Batch, r.body); return { results: await this.t.ingest(b, v.events) };
  }

  // ---- back office
  @Auth({ permission: "device:manage", target: "any" }) @Get("terminals") list(@Req() r: Request) { return this.t.list(this.o(r), this.u(r)); }
  @Auth({ permission: "device:manage", target: { body: "locationId" } }) @Post("bridges") createBridge(@Body() b: unknown, @Req() r: Request) { return this.t.createBridge(this.o(r), this.u(r), parse(z.object({ locationId: uuid, name: z.string().trim().min(1).max(60) }), b), r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "org" }) @Post("bridges/:id/pairing") @HttpCode(200) renew(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.renewPairing(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "org" }) @Post("bridges/:id/revoke") @HttpCode(200) revokeBridge(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.revokeBridge(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "device:manage", target: { body: "locationId" } }) @Post("terminals") createTerminal(@Body() b: unknown, @Req() r: Request) { return this.t.createTerminal(this.o(r), this.u(r), parse(z.object({ locationId: uuid, serial: z.string().trim().min(3).max(40), name: z.string().trim().min(1).max(60) }), b), r.ip ?? null); }
  @Auth({ permission: "device:manage", target: "org" }) @Post("terminals/:id/revoke") @HttpCode(200) revokeTerminal(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.revokeTerminal(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "user:manage", target: "org" }) @Put("users/:id/terminal-code") @HttpCode(200) personCode(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.t.setPersonCode(this.o(r), this.u(r), id, parse(z.object({ code: z.string().trim().min(1).max(40).nullable() }), b).code, r.ip ?? null); }

  @Auth({ permission: "timesheet:read", target: { query: "locationId" } }) @Get("terminal-events") events(@Query("locationId", new ParseUUIDPipe()) locationId: string, @Query("status") status: string | undefined, @Req() r: Request) { return this.t.review(this.o(r), this.u(r), { locationId, status }); }
  @Auth({ permission: "timesheet:approve", target: "any" }) @Post("terminal-events/:id/resolve") @HttpCode(200) resolve(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.t.resolve(this.o(r), this.u(r), id, parse(z.object({ userId: uuid }), b), r.ip ?? null); }
  @Auth({ permission: "timesheet:approve", target: "any" }) @Post("terminal-events/:id/dismiss") @HttpCode(200) dismiss(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.t.dismiss(this.o(r), this.u(r), id, r.ip ?? null); }

  @Auth({ aud: ["admin", "pos"], permission: "location:read", target: "any" }) @Get("punches/status") status(@Query("locationId", new ParseUUIDPipe()) locationId: string, @Req() r: Request) { return this.t.myStatus(this.o(r), this.u(r), locationId); }
}
