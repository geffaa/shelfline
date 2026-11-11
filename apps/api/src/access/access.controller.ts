import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth, Public } from "../auth/guard";
import { parse } from "../common/zod";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { emailOutbox } from "../db/schema";
import { desc, sql } from "drizzle-orm";
import { GrantsService } from "./grants.service";
import { PortalService } from "./portal.service";

const uuid = z.string().uuid(); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Grant = z.object({
  email: z.string().trim().email().max(200), name: z.string().trim().max(120).optional(), reportKeys: z.array(z.string().max(40)).min(1).max(20), locationIds: z.array(uuid).max(200).nullable(),
  rangeKind: z.enum(["fixed", "rolling"]), rangeFrom: ymd.nullable().optional(), rangeTo: ymd.nullable().optional(), rollingDays: z.number().int().min(1).max(366).nullable().optional(),
  hiddenColumns: z.array(z.string().max(40)).max(40).default([]), expiresAt: z.string().max(40).nullable().optional(),
});
const Run = z.object({ locationId: uuid.optional(), from: ymd.optional(), to: ymd.optional(), groupBy: z.string().max(20).optional(), format: z.enum(["json", "csv"]).default("json") });
const Email = z.object({ email: z.string().trim().email().max(200) });
const Verify = z.object({ email: z.string().trim().email().max(200), code: z.string().trim().regex(/^\d{6}$/) });

/** Administrators: who may see what. Owners only (permission report:grant). */
@Controller()
export class AccessController {
  constructor(@Inject(GrantsService) private g: GrantsService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Auth({ permission: "report:grant", target: "org" }) @Get("report-catalog") catalog() { return this.g.catalog(); }
  @Auth({ permission: "report:grant", target: "org" }) @Get("report-grants") list(@Req() r: Request) { return this.g.list(this.o(r)); }
  @Auth({ permission: "report:grant", target: "org" }) @Post("report-grants") create(@Body() b: unknown, @Req() r: Request) { return this.g.create(this.o(r), this.u(r), parse(Grant, b), r.ip ?? null); }
  @Auth({ permission: "report:grant", target: "org" }) @Post("report-grants/:id/revoke") @HttpCode(200) revoke(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.g.revoke(this.o(r), this.u(r), id, r.ip ?? null); }
  @Auth({ permission: "report:grant", target: "org" }) @Get("report-grants/:id/preview/:key")
  preview(@Param("id", new ParseUUIDPipe()) id: string, @Param("key") key: string, @Query() q: unknown, @Req() r: Request) { const p = parse(Run, q); return this.g.preview(this.o(r), id, key, p); }
  @Auth({ permission: "report:grant", target: "org" }) @Get("report-grants/:id/views") views(@Param("id", new ParseUUIDPipe()) id: string, @Req() r: Request) { return this.g.views(this.o(r), id); }
}

/** The portal: its own token audience, its own prefix. A portal token is refused everywhere else, and an admin token is refused here. */
@Controller("portal")
export class PortalController {
  constructor(@Inject(PortalService) private p: PortalService) {}
  private o(r: Request) { return r.principal!.orgId; } private u(r: Request) { return r.principal!.userId; }
  @Public() @Post("auth/request-code") @HttpCode(204) async request(@Body() b: unknown) { await this.p.requestCode(parse(Email, b).email); }
  @Public() @Post("auth/verify") @HttpCode(200) verify(@Body() b: unknown, @Req() r: Request) { const v = parse(Verify, b); return this.p.verify(v.email, v.code, r.ip ?? null); }
  @Auth({ aud: ["portal"] }) @Get("me") me(@Req() r: Request) { return this.p.me(this.o(r), this.u(r)); }
  @Auth({ aud: ["portal"] }) @Get("grants") grants(@Req() r: Request) { return this.p.myGrants(this.o(r), this.u(r)); }
  @Auth({ aud: ["portal"] }) @Get("grants/:id/reports/:key")
  async run(@Param("id", new ParseUUIDPipe()) id: string, @Param("key") key: string, @Query() q: unknown, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const p = parse(Run, q); const out = await this.p.run(this.o(r), this.u(r), id, key, p, p.format, r.ip ?? null);
    if (p.format === "csv") { res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="${key}-${out.scope.from}-${out.scope.to}.csv"`); return this.p.csv(out); }
    return out;
  }
}

/** Development only: the mail the system would have sent, newest first. 404 unless DEV_MAILBOX=1. */
@Controller("dev")
export class DevController {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config) {}
  @Public() @Get("mailbox")
  async mailbox(@Query("to") to?: string) {
    if (!this.cfg.devMailbox) throw new NotFoundException();
    const rows = await this.db.select().from(emailOutbox).where(to ? sql`lower(${emailOutbox.toEmail}) = ${to.toLowerCase()}` : undefined).orderBy(desc(emailOutbox.createdAt)).limit(20);
    return rows.map((m) => ({ to: m.toEmail, subject: m.subject, body: m.body, kind: m.kind, at: m.createdAt, attachment: m.attachmentName ? { name: m.attachmentName, type: m.attachmentType, bytes: Math.round((m.attachmentBase64?.length ?? 0) * 0.75) } : null }));
  }
}
