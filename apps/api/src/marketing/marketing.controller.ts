import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { LoyaltyService } from "./loyalty.service";
import { MarketingService } from "./marketing.service";

const uuid = z.string().uuid(); const int = (a: number, b: number) => z.number().int().min(a).max(b);
const Rules = z.object({ lastPurchaseBeforeDays: int(0, 3650).optional(), lastPurchaseWithinDays: int(0, 3650).optional(), minOrders: int(0, 100000).optional(), maxOrders: int(0, 100000).optional(), minSpentMinor: int(0, 1_000_000_000).optional(), locationIds: z.array(uuid).max(100).optional(), tiers: z.array(z.string().max(40)).max(20).optional(), birthdayMonth: int(1, 12).optional(), neverPurchased: z.boolean().optional() }).strict();
const Seg = z.object({ name: z.string().trim().min(1).max(80), rules: Rules });
const Camp = z.object({ name: z.string().trim().min(1).max(120), segmentId: uuid.nullable().default(null), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(10_000) });
const CampPatch = Camp.partial().extend({ segmentId: uuid.nullable().optional() }).strict();
const FlowPatch = z.object({ active: z.boolean().optional(), config: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(10_000), inactiveDays: int(7, 3650), afterDays: int(1, 90) }).partial().optional() }).strict();
const Program = z.object({ enabled: z.boolean(), pointsPerDollar: int(0, 100), tiers: z.array(z.object({ name: z.string().trim().min(1).max(30), min: int(0, 10_000_000), multBp: int(5000, 50000) })).min(1).max(8), redeemPoints: int(1, 100000), redeemValueMinor: int(0, 1_000_000), birthdayBonus: int(0, 10000) });

@Controller()
export class MarketingController {
  constructor(@Inject(MarketingService) private m: MarketingService, @Inject(LoyaltyService) private l: LoyaltyService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/settings") settings(@Req() r: Request) { return this.m.settings(this.o(r)); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Put("marketing/settings") setSettings(@Body() b: unknown, @Req() r: Request) { return this.m.setSettings(this.o(r), this.u(r), parse(z.object({ minGapDays: int(0, 90) }), b), r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/segments") segments(@Req() r: Request) { return this.m.listSegments(this.o(r)); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/segments") createSegment(@Body() b: unknown, @Req() r: Request) { return this.m.createSegment(this.o(r), this.u(r), parse(Seg, b), r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/segments/preview") @HttpCode(200) preview(@Body() b: unknown, @Req() r: Request) { return this.m.preview(this.o(r), parse(z.object({ rules: Rules }), b).rules); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Delete("marketing/segments/:id") deleteSegment(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.m.deleteSegment(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/campaigns") campaigns(@Req() r: Request) { return this.m.listCampaigns(this.o(r)); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/campaigns") createCampaign(@Body() b: unknown, @Req() r: Request) { return this.m.createCampaign(this.o(r), this.u(r), parse(Camp, b), r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Patch("marketing/campaigns/:id") patchCampaign(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.m.updateCampaign(this.o(r), this.u(r), id, parse(CampPatch, b) as never, r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/campaigns/:id/audience") audience(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.m.campaignAudience(this.o(r), id); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/campaigns/:id/send") @HttpCode(200) send(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.m.sendCampaign(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/campaigns/:id/cancel") @HttpCode(200) cancel(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.m.cancelCampaign(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/campaigns/:id/messages") messages(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.m.messages(this.o(r), id); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("marketing/flows") flows(@Req() r: Request) { return this.m.flows(this.o(r)); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Patch("marketing/flows/:id") patchFlow(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.m.updateFlow(this.o(r), this.u(r), id, parse(FlowPatch, b), r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("marketing/flows/run") @HttpCode(200) runFlows(@Req() r: Request) { return this.m.runFlows(this.o(r), new Date()); }

  /** The link in every marketing email. No sign-in: the signature in the address is the proof. */
  @Public() @Get("marketing/unsubscribe") @Header("content-type", "text/html; charset=utf-8")
  async unsubscribe(@Query("c") c?: string, @Query("s") s?: string) { const r = await this.m.unsubscribe(parse(uuid, c ?? ""), s ?? ""); return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Unsubscribed</title><body style="font:16px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>You are unsubscribed</h1><p>${r.shop.replace(/[<&>]/g, "")} will not send you marketing email any more. Receipts and order messages are not affected.</p></body>`; }

  @Auth({ permission: "marketing:manage", target: "org" }) @Get("loyalty/program") program(@Req() r: Request) { return this.l.program(this.o(r)); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Put("loyalty/program") setProgram(@Body() b: unknown, @Req() r: Request) { return this.l.setProgram(this.o(r), this.u(r), parse(Program, b), r.ip ?? null); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Get("loyalty/top") top(@Req() r: Request) { return this.l.top(this.o(r)); }
  /** The till shows a customer's points and tier. It already holds the customer's name and consent, so this adds only the standing, not the history. */
  @Auth({ aud: ["pos"] }) @Get("pos/loyalty/:id") async standing(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { const { entries: _e, ...rest } = await this.l.customerView(this.o(r), id); return rest; }
  @Auth({ permission: "customer:read", target: "any" }) @Get("loyalty/customers/:id") customer(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.l.customerView(this.o(r), id); }
  @Auth({ permission: "marketing:manage", target: "org" }) @Post("loyalty/customers/:id/adjust") @HttpCode(200) adjust(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.l.adjust(this.o(r), this.u(r), id, parse(z.object({ points: int(-100000, 100000), reason: z.string().trim().min(3).max(200), idempotencyKey: uuid }), b), r.ip ?? null); }
  @Auth({ permission: "giftcard:write", target: "any" }) @Post("loyalty/customers/:id/redeem") @HttpCode(200) redeem(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.l.redeem(this.o(r), this.u(r), id, parse(z.object({ points: int(1, 1_000_000), idempotencyKey: uuid }), b), r.ip ?? null); }
}
