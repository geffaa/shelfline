import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { currentTenant } from "../db/tenant";
import { Reflector } from "@nestjs/core";
import { and, eq } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { device, user } from "../db/schema";
import { AuthzService } from "./authz.service";
import type { Permission } from "./permissions";
import { TokenService, type Audience } from "./tokens";

export interface Principal { userId: string; orgId: string; aud: Audience; deviceId?: string; ip: string | null; authAt?: number }
/** Where the target location of a write comes from. 'org' = organisation-wide, 'any' = filtered later by scope. */
export type Target = "org" | "any" | { param: string } | { body: string } | { query: string };
export interface AuthOptions { aud?: Audience[]; permission?: Permission; target?: Target; public?: boolean }

const META = "shelfline:auth";
export const Auth = (o: AuthOptions = {}) => SetMetadata(META, o);
export const Public = () => SetMetadata(META, { public: true } satisfies AuthOptions);

declare global { namespace Express { interface Request { principal?: Principal } } }

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private reflector: Reflector, @Inject(TokenService) private tokens: TokenService,
    @Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService, @Inject(AuditService) private audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<AuthOptions | undefined>(META, [ctx.getHandler(), ctx.getClass()]) ?? {};
    if (opts.public) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? "";
    const claims = header.startsWith("Bearer ") ? await this.tokens.verify(header.slice(7), opts.aud ?? ["admin"]) : null;
    if (!claims) throw new UnauthorizedException({ code: "unauthenticated" });

    const [u] = await this.db.select({ id: user.id, status: user.status }).from(user).where(and(eq(user.id, claims.sub), eq(user.orgId, claims.org)));
    if (!u || u.status !== "active") throw new UnauthorizedException({ code: "unauthenticated" });
    if (claims.aud === "pos") {
      const [d] = claims.dev ? await this.db.select({ status: device.status }).from(device).where(eq(device.id, claims.dev)) : [];
      if (!d || d.status !== "active") throw new UnauthorizedException({ code: "device_revoked" });
    }
    const principal: Principal = { userId: claims.sub, orgId: claims.org, aud: claims.aud, deviceId: claims.dev, ip: req.ip ?? null, authAt: claims.at };
    req.principal = principal; const cell = currentTenant(); if (cell) cell.orgId = principal.orgId;

    if (!opts.permission) return true;
    const target = opts.target ?? "org";
    let ok: boolean;
    let locationId: string | undefined;
    if (target === "any") {
      const s = await this.authz.scope(principal.userId, opts.permission);
      ok = s.all || s.locationIds.length > 0;
    } else if (target === "org") {
      ok = await this.authz.can(principal.userId, opts.permission);
    } else {
      const v = "param" in target ? req.params?.[target.param] : "body" in target ? req.body?.[target.body] : req.query?.[target.query];
      locationId = typeof v === "string" ? v : undefined;
      ok = !!locationId && (await this.authz.can(principal.userId, opts.permission, locationId));
    }
    if (!ok) {
      await this.audit.record({ orgId: principal.orgId, actorId: principal.userId, action: "authz.denied", detail: { permission: opts.permission, locationId, method: req.method, path: req.path }, ip: principal.ip, deviceId: principal.deviceId });
      throw new ForbiddenException({ code: "forbidden", permission: opts.permission });
    }
    return true;
  }
}
