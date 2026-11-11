import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { parse } from "../common/zod";
import { DB, type Db } from "../db/db.module";
import { location, role, rolePermission, user, userAssignment } from "../db/schema";
import { Auth, Public } from "./guard";
import { AuthService } from "./auth.service";
import { TokenService } from "./tokens";

const Login = z.object({ email: z.string().email(), password: z.string().min(1), totp: z.string().regex(/^\d{6}$/).optional(), org: z.string().max(40).optional() });
const Approve = z.object({ managerEmployeeCode: z.string().min(1).max(32), pin: z.string().regex(/^\d{4,8}$/), kind: z.enum(["discount", "variance", "refund"]) });
const Pin = z.object({ employeeCode: z.string().min(1).max(32), pin: z.string().regex(/^\d{4,8}$/) });

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(DB) private db: Db, @Inject(TokenService) private tokens: TokenService) {}

  @Public() @Post("auth/login") @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request) { const b = parse(Login, body); return this.auth.login(b.email, b.password, b.totp, req.ip ?? null, b.org); }

  @Public() @Post("pos/pin") @HttpCode(200)
  pin(@Body() body: unknown, @Headers("x-device-key") key: string | undefined, @Req() req: Request) {
    const b = parse(Pin, body); return this.auth.pinLogin(key, b.employeeCode, b.pin, req.ip ?? null);
  }

  @Auth({ aud: ["pos"] }) @Post("pos/approve") @HttpCode(200)
  approve(@Body() body: unknown, @Headers("x-device-key") key: string | undefined, @Req() req: Request) {
    const b = parse(Approve, body); return this.auth.approve(key, b.managerEmployeeCode, b.pin, b.kind, req.ip ?? null);
  }

  /** Sliding session: a valid admin token buys a fresh 15-minute one, up to 8 hours after the password was last entered. */
  @Auth({ aud: ["admin"] }) @Post("auth/refresh") @HttpCode(200)
  async refresh(@Req() req: Request) {
    const p = req.principal!; const authAt = p.authAt ?? 0;
    if (Date.now() / 1000 - authAt > 8 * 3600) throw new UnauthorizedException({ code: "session_expired" });
    return this.tokens.issue({ userId: p.userId, orgId: p.orgId, aud: "admin", authAt });
  }

  @Auth({ aud: ["admin", "pos"] }) @Get("auth/me")
  async me(@Req() req: Request) {
    const p = req.principal!;
    const [u] = await this.db.select({ id: user.id, email: user.email, name: user.name, totpEnabled: user.totpEnabled }).from(user).where(eq(user.id, p.userId));
    const rows = await this.db.select({ roleKey: role.key, locationId: userAssignment.locationId, locationName: location.name, permission: rolePermission.permission })
      .from(userAssignment).innerJoin(role, eq(role.id, userAssignment.roleId))
      .leftJoin(location, eq(location.id, userAssignment.locationId)).leftJoin(rolePermission, eq(rolePermission.roleId, role.id))
      .where(eq(userAssignment.userId, p.userId));
    const byKey = new Map<string, { role: string; locationId: string | null; locationName: string | null; permissions: Set<string> }>();
    for (const r of rows) {
      const k = `${r.roleKey}|${r.locationId}`;
      const e = byKey.get(k) ?? { role: r.roleKey, locationId: r.locationId, locationName: r.locationName, permissions: new Set<string>() };
      if (r.permission) e.permissions.add(r.permission);
      byKey.set(k, e);
    }
    return { user: u, audience: p.aud, assignments: [...byKey.values()].map((e) => ({ ...e, permissions: [...e.permissions].sort() })) };
  }

  @Auth({ aud: ["admin"] }) @Post("auth/totp/setup") @HttpCode(200)
  totpSetup(@Req() req: Request) { return this.auth.totpSetup(req.principal!.userId); }

  @Auth({ aud: ["admin"] }) @Post("auth/totp/enable") @HttpCode(204)
  async totpEnable(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), body);
    await this.auth.totpEnable(req.principal!.userId, req.principal!.orgId, b.code);
  }
}
