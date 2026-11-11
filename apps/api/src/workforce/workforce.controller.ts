import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { WorkforceService } from "./workforce.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const hm = z.string().regex(/^[0-2]\d:[0-5]\d$/);
const Shift = z.object({ locationId: uuid, userId: uuid.nullable().optional(), date: ymd, start: hm, end: hm, role: z.string().trim().max(40).nullable().optional(), breakMinutes: z.number().int().min(0).max(480).optional(), note: z.string().max(200).nullable().optional() });
const ShiftPatch = Shift.omit({ locationId: true }).partial().refine((o) => Object.keys(o).length > 0, "nothing to change");
const Range = z.object({ locationId: uuid, from: ymd, to: ymd }).refine((o) => o.from <= o.to && Date.parse(o.to) - Date.parse(o.from) <= 62 * 86_400_000, "range too long or reversed");
const Template = z.object({ name: z.string().trim().min(1).max(60), startTime: hm, endTime: hm, role: z.string().trim().max(40).nullable().optional(), breakMinutes: z.number().int().min(0).max(480).optional(), locationId: uuid.nullable().optional() });
const Apply = z.object({ locationId: uuid, templateId: uuid, dates: z.array(ymd).min(1).max(62), userIds: z.array(uuid).max(50).default([]) });
const Correct = z.object({ userId: uuid, locationId: uuid, kind: z.enum(["in", "out"]), at: z.string().datetime({ offset: true }), supersedesPunchId: uuid.nullable().optional(), reason: z.string().trim().min(3).max(200) });
const Staffing = z.record(z.string().regex(/^[0-6]$/), z.number().int().min(0).max(50));

@Controller()
export class WorkforceController {
  constructor(@Inject(WorkforceService) private w: WorkforceService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  @Auth({ permission: "roster:read", target: { query: "locationId" } }) @Get("shifts")
  shifts(@Query() q: unknown, @Req() r: Request) { const v = parse(Range.and(z.object({ userId: uuid.optional() })), q); return this.w.list(this.o(r), this.u(r), v); }
  @Auth({ aud: ["admin", "pos"], permission: "location:read", target: "any" }) @Get("shifts/mine")
  mine(@Query("from") from: string, @Query("to") to: string, @Req() r: Request) { return this.w.mine(this.o(r), this.u(r), { from: parse(ymd, from), to: parse(ymd, to) }); }
  @Auth({ permission: "roster:write", target: { body: "locationId" } }) @Post("shifts")
  create(@Body() b: unknown, @Req() r: Request) { return this.w.createShift(this.o(r), this.u(r), parse(Shift, b), r.ip ?? null); }
  @Auth({ permission: "roster:write", target: { body: "locationId" } }) @Post("shifts/publish") @HttpCode(200)
  publish(@Body() b: unknown, @Req() r: Request) { return this.w.publish(this.o(r), this.u(r), parse(Range, b), r.ip ?? null); }
  @Auth({ permission: "roster:write", target: { body: "locationId" } }) @Post("shifts/apply") @HttpCode(200)
  apply(@Body() b: unknown, @Req() r: Request) { return this.w.applyTemplate(this.o(r), this.u(r), parse(Apply, b), r.ip ?? null); }
  @Auth({ permission: "roster:write", target: "any" }) @Patch("shifts/:id")
  patch(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.w.updateShift(this.o(r), this.u(r), id, parse(ShiftPatch, b), r.ip ?? null); }
  @Auth({ permission: "roster:write", target: "any" }) @Delete("shifts/:id") @HttpCode(204)
  async remove(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { await this.w.deleteShift(this.o(r), this.u(r), id, r.ip ?? null); }

  @Auth({ permission: "roster:read", target: "any" }) @Get("shift-templates") templates(@Req() r: Request) { return this.w.templates(this.o(r)); }
  @Auth({ permission: "roster:write", target: "any" }) @Post("shift-templates") createTemplate(@Body() b: unknown, @Req() r: Request) { return this.w.createTemplate(this.o(r), this.u(r), parse(Template, b), r.ip ?? null); }
  @Auth({ permission: "roster:read", target: { param: "id" } }) @Get("locations/:id/staffing") staffing(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.w.staffing(this.o(r), id); }
  @Auth({ permission: "roster:write", target: { param: "id" } }) @Put("locations/:id/staffing") @HttpCode(200) setStaffing(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.w.setStaffing(this.o(r), this.u(r), id, parse(Staffing, b), r.ip ?? null); }

  @Auth({ permission: "timesheet:read", target: { query: "locationId" } }) @Get("timesheets")
  timesheets(@Query() q: unknown, @Req() r: Request) { return this.w.timesheets(this.o(r), this.u(r), parse(Range.and(z.object({ userId: uuid.optional() })), q)); }
  @Auth({ aud: ["admin", "pos"], permission: "location:read", target: "any" }) @Get("timesheets/mine")
  mineEntries(@Query() q: unknown, @Req() r: Request) { return this.w.minePunches(this.o(r), this.u(r), parse(Range, q)); }
  @Auth({ permission: "timesheet:approve", target: { body: "locationId" } }) @Post("timesheets/corrections")
  correct(@Body() b: unknown, @Req() r: Request) { return this.w.correct(this.o(r), this.u(r), parse(Correct, b), r.ip ?? null); }
  @Auth({ permission: "timesheet:approve", target: "any" }) @Post("timesheets/approve") @HttpCode(200)
  approve(@Body() b: unknown, @Req() r: Request) { return this.w.approve(this.o(r), this.u(r), parse(z.object({ ids: z.array(uuid).min(1).max(200) }), b).ids, r.ip ?? null); }
}
