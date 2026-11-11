import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { NOTIFICATION_KINDS } from "../db/schema";
import { NotificationsService } from "./notifications.service";

const uuid = z.string().uuid(); const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/); const int = z.number().int().min(0).max(100_000_000);
const Rule = z.object({
  name: z.string().trim().min(1).max(120), eventKind: z.enum(NOTIFICATION_KINDS), locationIds: z.array(uuid).max(200).nullable().default(null),
  conditions: z.object({ minMinor: int.optional(), minLateMinutes: z.number().int().min(0).max(1440).optional(), varianceOverMinor: int.optional() }).strict().default({}),
  recipientUserIds: z.array(uuid).max(100).default([]), recipientRoles: z.array(z.string().max(40)).max(10).default([]), channels: z.array(z.enum(["in_app", "email"])).min(1).max(2).default(["in_app"]),
  quietStart: hm.nullable().default(null), quietEnd: hm.nullable().default(null), critical: z.boolean().default(false), digest: z.boolean().default(false), digestAt: hm.default("18:00"), active: z.boolean().default(true),
});
/** A patch has no defaults: only what is sent changes. */
const RulePatch = z.object({
  name: z.string().trim().min(1).max(120), eventKind: z.enum(NOTIFICATION_KINDS), locationIds: z.array(uuid).max(200).nullable(),
  conditions: z.object({ minMinor: int.optional(), minLateMinutes: z.number().int().min(0).max(1440).optional(), varianceOverMinor: int.optional() }).strict(),
  recipientUserIds: z.array(uuid).max(100), recipientRoles: z.array(z.string().max(40)).max(10), channels: z.array(z.enum(["in_app", "email"])).min(1).max(2),
  quietStart: hm.nullable(), quietEnd: hm.nullable(), critical: z.boolean(), digest: z.boolean(), digestAt: hm, active: z.boolean(),
}).partial().strict();
const Read = z.object({ ids: z.array(uuid).max(200).optional(), all: z.boolean().optional() }).refine((o) => o.all || (o.ids && o.ids.length > 0), "say which");

@Controller()
export class NotificationsController {
  constructor(@Inject(NotificationsService) private n: NotificationsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth() @Get("notifications") inbox(@Req() r: Request, @Query("unread") unread?: string, @Query("limit") limit?: string) { return this.n.inbox(this.o(r), this.u(r), { unread: unread === "1", limit: limit ? Number(limit) : undefined }); }
  @Auth() @Get("notifications/unread-count") unread(@Req() r: Request) { return this.n.unread(this.o(r), this.u(r)); }
  @Auth() @Post("notifications/read") @HttpCode(200) read(@Body() b: unknown, @Req() r: Request) { return this.n.markRead(this.o(r), this.u(r), parse(Read, b)); }

  @Auth({ permission: "notification:manage", target: "org" }) @Get("notification-rules") rules(@Req() r: Request) { return this.n.listRules(this.o(r)); }
  @Auth({ permission: "notification:manage", target: "org" }) @Post("notification-rules") create(@Body() b: unknown, @Req() r: Request) { return this.n.createRule(this.o(r), this.u(r), parse(Rule, b), r.ip ?? null); }
  @Auth({ permission: "notification:manage", target: "org" }) @Patch("notification-rules/:id") patch(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.n.updateRule(this.o(r), this.u(r), id, parse(RulePatch, b) as never, r.ip ?? null); }
  @Auth({ permission: "notification:manage", target: "org" }) @Get("notification-log") log(@Req() r: Request, @Query("ruleId") ruleId?: string) { return this.n.log(this.o(r), ruleId ? parse(uuid, ruleId) : undefined); }
}
