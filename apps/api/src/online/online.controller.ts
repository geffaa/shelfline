import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, HttpException } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { device } from "../db/schema";
import { eq } from "drizzle-orm";
import { OnlineService } from "./online.service";

const uuid = z.string().uuid();
const Order = z.object({ email: z.string().trim().email().max(200), name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).nullable().optional(), locationId: uuid, lines: z.array(z.object({ variantId: uuid, qty: z.number().int().min(1).max(20) })).min(1).max(30) });

/** Anyone may place an order, so it is rate limited by address and by email. (In memory: one server process; a shared store is the production answer.) */
class Limiter {
  private hits = new Map<string, number[]>();
  allow(key: string, max: number, windowMs: number, now = Date.now()) { const h = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs); if (h.length >= max) { this.hits.set(key, h); return false; } h.push(now); this.hits.set(key, h); if (this.hits.size > 5000) this.hits.clear(); return true; }
}

@Controller()
export class OnlineController {
  private limiter = new Limiter();
  constructor(@Inject(OnlineService) private s: OnlineService, @Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }

  // ---- the shop window (public)
  /** For a single-shop install: the storefront may be pointed at "the only organisation" instead of being given its id. With more than one organisation it refuses, and each storefront names its own. */
  @Public() @Get("shop-default") async only(@Query("slug") slug?: string) { return this.s.onlyOrg(slug); }
  @Public() @Get("shop/:orgId") shop(@Param("orgId", new ParseUUIDPipe()) orgId: string) { return this.s.storefront(orgId); }
  @Public() @Get("shop/:orgId/products") products(@Param("orgId", new ParseUUIDPipe()) orgId: string, @Query("q") q?: string, @Query("categoryId") categoryId?: string, @Query("offset") offset?: string) { return this.s.catalog(orgId, { q: q?.slice(0, 60), categoryId: categoryId ? parse(uuid, categoryId) : undefined, offset: offset ? Math.max(0, Number(offset) || 0) : 0 }); }
  @Public() @Get("shop/:orgId/products/:id") one(@Param("orgId", new ParseUUIDPipe()) orgId: string, @Param("id", new ParseUUIDPipe()) id: string) { return this.s.productPage(orgId, id); }
  @Public() @Post("shop/:orgId/orders") @HttpCode(201)
  order(@Param("orgId", new ParseUUIDPipe()) orgId: string, @Body() b: unknown, @Req() r: Request) {
    const v = parse(Order, b); if (!this.limiter.allow(`ip:${r.ip}`, this.cfg.shopIpLimit, 10 * 60_000) || !this.limiter.allow(`mail:${v.email.toLowerCase()}`, 5, 60 * 60_000)) throw new HttpException({ code: "slow_down" }, 429);
    return this.s.place(orgId, v);
  }
  @Public() @Get("shop/:orgId/orders/:id") view(@Param("orgId", new ParseUUIDPipe()) orgId: string, @Param("id", new ParseUUIDPipe()) id: string, @Query("t") t?: string) { return this.s.customerView(orgId, id, t ?? ""); }
  @Public() @Post("shop/:orgId/orders/:id/cancel") @HttpCode(200) cancelMine(@Param("orgId", new ParseUUIDPipe()) orgId: string, @Param("id", new ParseUUIDPipe()) id: string, @Query("t") t?: string) { return this.s.customerCancel(orgId, id, t ?? ""); }

  // ---- the back office
  @Auth({ permission: "sale:read", target: "any" }) @Get("online-orders") list(@Req() r: Request, @Query("status") status?: string, @Query("locationId") locationId?: string) { return this.s.list(this.o(r), this.u(r), { status, locationId: locationId ? parse(uuid, locationId) : undefined }); }
  @Auth({ permission: "sale:read", target: "any" }) @Post("online-orders/:id/ready") @HttpCode(200) ready(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.s.ready(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "sale:read", target: "any" }) @Post("online-orders/:id/cancel") @HttpCode(200) cancel(@Param("id", new ParseUUIDPipe()) id: string, @Body() b: unknown, @Req() r: Request) { return this.s.cancel(this.o(r), this.u(r), id, parse(z.object({ reason: z.string().trim().min(3).max(200) }), b).reason, r.ip ?? null); }

  // ---- the till
  @Auth({ aud: ["pos"] }) @Get("pos/online-orders/lookup")
  async lookup(@Query("code") code: string | undefined, @Req() r: Request) { const [d] = await this.db.select({ l: device.locationId }).from(device).where(eq(device.id, r.principal!.deviceId!)); return this.s.lookup(this.o(r), d!.l, parse(z.string().trim().min(4).max(12), code ?? "")); }
}
