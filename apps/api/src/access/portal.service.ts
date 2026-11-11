import { ForbiddenException, GoneException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { location, portalLoginCode, reportGrant, user } from "../db/schema";
import { TokenService } from "../auth/tokens";
import { REPORTS } from "./catalog";
import { factsOf, GrantsService } from "./grants.service";
import { MailService } from "./mail.service";
import { ReportRunner } from "./runner.service";
import { endedReason, ReportScope, windowOf } from "./scope";

const CODE_TTL_MS = 10 * 60_000, MAX_ATTEMPTS = 5, MAX_REQUESTS = 5, WINDOW_MS = 15 * 60_000;
const hash = (userId: string, code: string) => createHash("sha256").update(`${userId}:${code}`).digest("hex");

@Injectable()
export class PortalService {
  constructor(@Inject(DB) private db: Db, @Inject(TokenService) private tokens: TokenService, @Inject(MailService) private mail: MailService, @Inject(GrantsService) private grants: GrantsService,
    @Inject(ReportRunner) private runner: ReportRunner, @Inject(AuditService) private audit: AuditService) {}

  /** Always answers the same way, so nobody can use it to find out who has access. A code is only made for an active person who holds at least one grant. */
  async requestCode(email: string) {
    const e = email.trim().toLowerCase();
    const [u] = await this.db.select().from(user).where(and(eq(user.status, "active"), sql`lower(${user.email}) = ${e}`)).limit(1); if (!u) return;
    const [g] = await this.db.select({ id: reportGrant.id }).from(reportGrant).where(eq(reportGrant.granteeUserId, u.id)).limit(1); if (!g) return;
    const recent = (await this.db.select({ n: sql<number>`count(*)::int` }).from(portalLoginCode).where(and(eq(portalLoginCode.userId, u.id), gt(portalLoginCode.createdAt, new Date(Date.now() - WINDOW_MS)))))[0]!.n;
    if (recent >= MAX_REQUESTS) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.db.transaction(async (tx) => {
      await tx.update(portalLoginCode).set({ usedAt: new Date() }).where(and(eq(portalLoginCode.userId, u.id), isNull(portalLoginCode.usedAt)));   // an older code stops working
      await tx.insert(portalLoginCode).values({ userId: u.id, codeHash: hash(u.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) });
      await this.mail.send(u.orgId, { to: e, kind: "portal_code", subject: `Your Shelfline sign-in code: ${code}`, body: `Your code is ${code}. It works once and expires in 10 minutes.` }, tx);
    });
  }

  async verify(email: string, code: string, ip: string | null) {
    const e = email.trim().toLowerCase(); const fail = () => new HttpException({ code: "bad_code" }, 401);
    const [u] = await this.db.select().from(user).where(and(eq(user.status, "active"), sql`lower(${user.email}) = ${e}`)).limit(1); if (!u) throw fail();
    const [c] = await this.db.select().from(portalLoginCode).where(and(eq(portalLoginCode.userId, u.id), isNull(portalLoginCode.usedAt), gt(portalLoginCode.expiresAt, new Date()))).orderBy(desc(portalLoginCode.createdAt)).limit(1); if (!c) throw fail();
    if (c.attempts >= MAX_ATTEMPTS) throw new HttpException({ code: "too_many_attempts" }, 429);
    const ok = (() => { const a = Buffer.from(hash(u.id, code.trim())), b = Buffer.from(c.codeHash); return a.length === b.length && timingSafeEqual(a, b); })();
    if (!ok) { await this.db.update(portalLoginCode).set({ attempts: c.attempts + 1 }).where(eq(portalLoginCode.id, c.id)); throw fail(); }
    await this.db.update(portalLoginCode).set({ usedAt: new Date() }).where(eq(portalLoginCode.id, c.id));
    await this.audit.record({ orgId: u.orgId, actorId: u.id, action: "portal.sign_in", ip });
    return { ...(await this.tokens.issue({ userId: u.id, orgId: u.orgId, aud: "portal" })), name: u.name };
  }

  async me(orgId: string, userId: string) { const [u] = await this.db.select({ name: user.name, email: user.email }).from(user).where(and(eq(user.id, userId), eq(user.orgId, orgId))); return u; }

  /** Everything this person was ever given, with ended ones kept so the screen can say who gave it. */
  async myGrants(orgId: string, userId: string) {
    const rows = await this.db.select().from(reportGrant).where(and(eq(reportGrant.granteeUserId, userId), eq(reportGrant.orgId, orgId))).orderBy(desc(reportGrant.createdAt)); const now = new Date();
    const people = new Map((await this.db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...new Set(rows.map((r) => r.createdBy))].length ? [...new Set(rows.map((r) => r.createdBy))] : ["00000000-0000-0000-0000-000000000000"]))).map((p) => [p.id, p.name]));
    const locs = new Map((await this.db.select({ id: location.id, name: location.name }).from(location).where(eq(location.orgId, orgId))).map((l) => [l.id, l.name]));
    const out = [];
    for (const g of rows) {
      const f = factsOf(g); const ended = endedReason(f, now); const today = await this.grants.todayFor(orgId, g.locationIds);
      out.push({ id: g.id, status: ended ?? "active", endedReason: ended, grantedBy: people.get(g.createdBy) ?? "your administrator", reports: g.reportKeys.map((k) => ({ key: k, title: REPORTS.find((r) => r.key === k)?.title ?? k })),
        locations: g.locationIds ? g.locationIds.map((i) => locs.get(i) ?? "?") : null, locationOptions: (g.locationIds ?? [...locs.keys()]).map((i) => ({ id: i, name: locs.get(i) ?? "?" })), window: windowOf(f, today), rangeKind: g.rangeKind, hiddenColumns: g.hiddenColumns, expiresAt: g.expiresAt });
    }
    return out;
  }

  async run(orgId: string, userId: string, grantId: string, key: string, req: { locationId?: string; from?: string; to?: string; groupBy?: string }, format: "json" | "csv", ip: string | null) {
    const [g] = await this.db.select().from(reportGrant).where(and(eq(reportGrant.id, grantId), eq(reportGrant.granteeUserId, userId), eq(reportGrant.orgId, orgId)));
    if (!g) throw new NotFoundException({ code: "grant_not_found" });
    const f = factsOf(g); const ended = endedReason(f, new Date());
    if (ended) { const [by] = await this.db.select({ name: user.name }).from(user).where(eq(user.id, g.createdBy)); throw new GoneException({ code: "access_ended", reason: ended, grantedBy: by?.name ?? null }); }
    if (!g.reportKeys.includes(key)) throw new ForbiddenException({ code: "report_not_granted" });
    const scope = ReportScope.fromGrant(f, key, await this.grants.todayFor(orgId, g.locationIds), new Date());
    const result = await this.runner.run(orgId, key, scope, req);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`insert into shelfline.report_view_log (org_id, grant_id, user_id, report_key, format, requested, served, row_count) values (${orgId}, ${grantId}, ${userId}, ${key}, ${format}, ${JSON.stringify(req)}::jsonb, ${JSON.stringify({ from: result.scope.from, to: result.scope.to, locations: result.scope.locations, groupBy: result.groupBy, clamped: result.scope.clamped, hidden: result.scope.hiddenColumns })}::jsonb, ${result.rows.length})`);
      await this.audit.record({ orgId, actorId: userId, action: "portal.report.view", subjectType: "report_grant", subjectId: grantId, detail: { key, format, from: result.scope.from, to: result.scope.to, rows: result.rows.length }, ip }, tx);
    });
    return result;
  }
  csv(r: Awaited<ReturnType<ReportRunner["run"]>>) { return this.runner.toCsv(r); }
}
