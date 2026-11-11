import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { EodService } from "./eod.service";

const uuid = z.string().uuid(); const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const shape = {
  name: z.string().trim().min(1).max(120), locationIds: z.array(uuid).max(200).nullable(), sendAtLocal: hm, daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7), timezone: z.string().trim().min(1).max(60),
  methods: z.array(z.enum(["email", "webhook"])).min(1).max(2), recipients: z.array(z.string().trim().email().max(200)).max(20), webhookUrl: z.string().trim().url().max(500).nullable(),
  format: z.enum(["pdf", "csv", "inline"]), onlyWhenClosed: z.boolean(), maxWaitMinutes: z.number().int().min(0).max(720), active: z.boolean(),
};
const Create = z.object({ ...shape, locationIds: shape.locationIds.default(null), recipients: shape.recipients.default([]), webhookUrl: shape.webhookUrl.default(null), format: shape.format.default("pdf"), onlyWhenClosed: shape.onlyWhenClosed.default(true), maxWaitMinutes: shape.maxWaitMinutes.default(120), active: shape.active.default(true), daysOfWeek: shape.daysOfWeek.default([0, 1, 2, 3, 4, 5, 6]) });
const SchedulePatch = z.object(shape).partial().strict();

@Controller()
export class EodController {
  constructor(@Inject(EodService) private e: EodService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Auth({ permission: "eod:manage", target: "org" }) @Get("eod-schedules") list(@Req() r: Request) { return this.e.list(this.o(r)); }
  @Auth({ permission: "eod:manage", target: "org" }) @Post("eod-schedules") create(@Body() b: unknown, @Req() r: Request) { return this.e.create(this.o(r), this.u(r), parse(Create, b) as never, r.ip ?? null); }
  @Auth({ permission: "eod:manage", target: "org" }) @Patch("eod-schedules/:id") patch(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.e.update(this.o(r), this.u(r), id, parse(SchedulePatch, b) as never, r.ip ?? null); }
  @Auth({ permission: "eod:manage", target: "org" }) @Post("eod-schedules/:id/send-now") @HttpCode(200) sendNow(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { const p = parse(z.object({ date: ymd.optional() }), b ?? {}); return this.e.sendNow(this.o(r), this.u(r), id, p.date, new Date(), r.ip ?? null); }
  @Auth({ permission: "eod:manage", target: "org" }) @Get("eod-runs") runs(@Req() r: Request, @Query("scheduleId") scheduleId?: string) { return this.e.runs(this.o(r), scheduleId ? parse(uuid, scheduleId) : undefined); }
  @Auth({ permission: "eod:manage", target: "org" }) @Get("eod-runs/:id") run(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.e.runText(this.o(r), id); }
}
