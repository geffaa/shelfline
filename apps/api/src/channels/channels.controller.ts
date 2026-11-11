import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { ChannelsService, DOMAIN } from "./channels.service";

const uuid = z.string().uuid();
const Connect = z.object({ name: z.string().trim().max(80).default(""), shopDomain: z.string().trim().toLowerCase().regex(DOMAIN, "a *.myshopify.com address"), accessToken: z.string().trim().min(8).max(200), webhookSecret: z.string().trim().min(8).max(200), locationId: uuid, shopifyLocationId: z.string().trim().regex(/^\d{4,20}$/), apiVersion: z.string().trim().regex(/^\d{4}-\d{2}$/).optional() });

@Controller()
export class ChannelsController {
  constructor(@Inject(ChannelsService) private c: ChannelsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Auth({ permission: "channel:manage", target: "org" }) @Get("channels") list(@Req() r: Request) { return this.c.list(this.o(r)); }
  @Auth({ permission: "channel:manage", target: "org" }) @Post("channels") connect(@Body() b: unknown, @Req() r: Request) { return this.c.connect(this.o(r), this.u(r), parse(Connect, b) as never, r.ip ?? null); }
  @Auth({ permission: "channel:manage", target: "org" }) @Patch("channels/:id") status(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.c.setStatus(this.o(r), this.u(r), id, parse(z.object({ status: z.enum(["active", "paused", "disconnected"]) }), b).status, r.ip ?? null); }
  @Auth({ permission: "channel:manage", target: "org" }) @Get("channels/:id/listings") listings(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.listings(this.o(r), id); }
  @Auth({ permission: "channel:manage", target: "org" }) @Get("channels/:id/orders") orders(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.orders(this.o(r), id); }
  @Auth({ permission: "channel:manage", target: "org" }) @Post("channels/:id/import") @HttpCode(200) importMap(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.importMap(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "channel:manage", target: "org" }) @Post("channels/:id/push") @HttpCode(200) push(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.push(this.o(r), id); }
  @Auth({ permission: "channel:manage", target: "org" }) @Post("channels/:id/reconcile") @HttpCode(200) reconcile(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.c.reconcile(this.o(r), this.u(r), id, r.ip ?? null); }

  /** Where Shopify sends its notices. No user: the signature over the exact bytes is the authentication. */
  @Public() @Post("channels/shopify/webhooks/:id") @HttpCode(200)
  webhook(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request & { rawBody?: Buffer }, @Headers("x-shopify-hmac-sha256") hmac?: string, @Headers("x-shopify-topic") topic?: string, @Headers("x-shopify-webhook-id") webhookId?: string) { return this.c.webhook(id, { hmac, topic, webhookId }, r.rawBody); }
}
