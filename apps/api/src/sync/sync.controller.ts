import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { INITIAL_CURSOR, PushRequest } from "@shelfline/contracts";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { SyncService } from "./sync.service";

@Controller("sync")
export class SyncController {
  constructor(@Inject(SyncService) private sync: SyncService) {}
  private dev = (r: Request) => this.sync.deviceFor(r.principal!.orgId, r.principal!.deviceId);

  @Auth({ aud: ["pos"] }) @Post("push") @HttpCode(200)
  async push(@Body() b: unknown, @Req() r: Request) { return this.sync.push(await this.dev(r), parse(PushRequest, b)); }

  @Auth({ aud: ["pos"] }) @Get("pull")
  async pull(@Req() r: Request, @Query("cursor") cursor?: string, @Query("limit") limit?: string) { return this.sync.pull(await this.dev(r), cursor ?? INITIAL_CURSOR, limit ? Math.max(1, Number(limit)) : undefined); }

  @Auth({ aud: ["pos"] }) @Get("snapshot")
  async snapshot(@Req() r: Request, @Query("after") after?: string, @Query("limit") limit?: string) { return this.sync.snapshot(await this.dev(r), after ?? null, limit ? Math.max(1, Math.min(5000, Number(limit))) : undefined); }

  @Auth({ aud: ["pos"] }) @Get("status")
  async status(@Req() r: Request) { return this.sync.status(await this.dev(r)); }

  @Auth({ permission: "audit:read", target: "org" }) @Get("exceptions")
  exceptions(@Req() r: Request, @Query("status") status?: string) { return this.sync.listExceptions(r.principal!.orgId, status === "resolved" ? "resolved" : "open"); }

  @Auth({ permission: "audit:read", target: "org" }) @Post("exceptions/:id/resolve") @HttpCode(204)
  async resolve(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { await this.sync.resolveException(r.principal!.orgId, r.principal!.userId, id, r.ip ?? null); }
}
