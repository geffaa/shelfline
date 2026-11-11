import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth } from "../auth/guard";
import { isValidTimeZone } from "../common/business-day";
import { parse } from "../common/zod";
import { OrgService } from "./org.service";

const tz = z.string().refine(isValidTimeZone, "unknown IANA time zone");
const cutoff = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const code = z.string().regex(/^[A-Za-z0-9-]{2,16}$/, "2-16 letters, digits or dashes").transform((s) => s.toUpperCase());
const NewLocation = z.object({ code, name: z.string().min(1).max(80), type: z.enum(["store", "warehouse", "virtual"]), timezone: tz, dayCutoff: cutoff.optional(), taxRegion: z.string().max(32).optional() });
const PatchLocation = z.object({ name: z.string().min(1).max(80), timezone: tz, dayCutoff: cutoff, taxRegion: z.string().max(32), status: z.enum(["active", "inactive"]), cashierDiscountLimitBp: z.number().int().min(0).max(10000), cashierRefundLimitMinor: z.number().int().min(0).max(100_000_000), cashVarianceLimitMinor: z.number().int().min(0).max(100_000_000), pickupEnabled: z.boolean(), giftCardOffline: z.boolean(), giftCardOfflineCapMinor: z.number().int().min(0).max(1_000_000) }).partial().refine((o) => Object.keys(o).length > 0, "empty patch");
const NewRegister = z.object({ code, name: z.string().min(1).max(80) });
const NewDevice = z.object({ kind: z.enum(["pos", "bridge", "terminal", "printer"]), locationId: z.string().uuid(), registerId: z.string().uuid().optional(), name: z.string().min(1).max(80), serial: z.string().max(80).optional() });

@Controller()
export class OrgController {
  constructor(@Inject(OrgService) private org: OrgService) {}

  @Auth({ permission: "location:write", target: "org" }) @Post("locations")
  createLocation(@Body() b: unknown, @Req() r: Request) { return this.org.createLocation(r.principal!.orgId, r.principal!.userId, parse(NewLocation, b), r.ip ?? null); }

  @Auth({ permission: "location:read", target: "any" }) @Get("locations")
  listLocations(@Req() r: Request) { return this.org.listLocations(r.principal!.orgId, r.principal!.userId); }

  @Auth({ permission: "location:read", target: { param: "id" } }) @Get("locations/:id")
  getLocation(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.org.getLocation(r.principal!.orgId, id); }

  @Auth({ permission: "location:write", target: { param: "id" } }) @Patch("locations/:id")
  updateLocation(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.org.updateLocation(r.principal!.orgId, r.principal!.userId, id, parse(PatchLocation, b), r.ip ?? null); }

  @Auth({ permission: "register:write", target: { param: "id" } }) @Post("locations/:id/registers")
  createRegister(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.org.createRegister(r.principal!.orgId, r.principal!.userId, id, parse(NewRegister, b), r.ip ?? null); }

  @Auth({ permission: "location:read", target: { param: "id" } }) @Get("locations/:id/registers")
  listRegisters(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.org.listRegisters(r.principal!.orgId, id); }

  @Auth({ permission: "device:manage", target: { body: "locationId" } }) @Post("devices")
  createDevice(@Body() b: unknown, @Req() r: Request) { return this.org.createDevice(r.principal!.orgId, r.principal!.userId, parse(NewDevice, b), r.ip ?? null); }

  @Auth({ permission: "device:manage", target: { query: "locationId" } }) @Get("devices")
  listDevices(@Query("locationId", new ParseUUIDPipe()) locationId: string, @Req() r: Request) { return this.org.listDevices(r.principal!.orgId, locationId); }

  @Auth({ permission: "device:manage", target: "org" }) @Post("devices/:id/revoke") @HttpCode(204)
  async revoke(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { await this.org.revokeDevice(r.principal!.orgId, r.principal!.userId, id, r.ip ?? null); }
}
