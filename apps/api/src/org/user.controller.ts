import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Auth } from "../auth/guard";
import { parse } from "../common/zod";
import { UserService } from "./user.service";

const Assignment = z.object({ role: z.string().min(1), locationId: z.string().uuid().nullable() });
const NewUser = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()), name: z.string().min(1).max(80),
  password: z.string().min(12).max(200).optional(), employeeCode: z.string().min(1).max(32).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(), assignments: z.array(Assignment).max(40).default([]),
}).refine((v) => !v.pin || v.employeeCode, { message: "pin requires employeeCode", path: ["pin"] });

@Controller()
export class UserController {
  constructor(@Inject(UserService) private users: UserService, @Inject(AuditService) private audit: AuditService) {}

  @Auth({ permission: "user:manage", target: "org" }) @Post("users")
  create(@Body() b: unknown, @Req() r: Request) { return this.users.create(r.principal!.orgId, r.principal!.userId, parse(NewUser, b), r.ip ?? null); }

  @Auth({ permission: "user:read", target: "any" }) @Get("users")
  list(@Req() r: Request) { return this.users.list(r.principal!.orgId, r.principal!.userId); }

  @Auth({ permission: "user:manage", target: "org" }) @Put("users/:id/assignments") @HttpCode(204)
  async assignments(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) {
    await this.users.setAssignments(r.principal!.orgId, r.principal!.userId, id, parse(z.object({ assignments: z.array(Assignment).max(40) }), b).assignments, r.ip ?? null);
  }

  @Auth({ permission: "user:manage", target: "org" }) @Post("users/:id/pin") @HttpCode(204)
  async pin(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) {
    await this.users.setPin(r.principal!.orgId, r.principal!.userId, id, parse(z.object({ pin: z.string().regex(/^\d{4,8}$/) }), b).pin, r.ip ?? null);
  }

  @Auth({ permission: "user:manage", target: "org" }) @Post("users/:id/disable") @HttpCode(204)
  async disable(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { await this.users.disable(r.principal!.orgId, r.principal!.userId, id, r.ip ?? null); }

  @Auth({ permission: "role:read", target: "org" }) @Get("roles")
  roles(@Req() r: Request) { return this.users.roles(r.principal!.orgId); }

  @Auth({ permission: "audit:read", target: "org" }) @Get("audit")
  auditList(@Req() r: Request, @Query("action") action?: string, @Query("beforeId") beforeId?: string, @Query("limit") limit?: string, @Query("actorId") actorId?: string, @Query("subjectType") subjectType?: string, @Query("subjectId") subjectId?: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.audit.list(r.principal!.orgId, { action, beforeId: beforeId ? Number(beforeId) : undefined, limit: limit ? Number(limit) : undefined, actorId, subjectType, subjectId, from, to });
  }
}
