import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { location, reportGrant, reportViewLog, user } from "../db/schema";
import { allColumnKeys, REPORT_KEYS, REPORTS } from "./catalog";
import { MailService } from "./mail.service";
import { endedReason, ReportScope, windowOf, type GrantFacts } from "./scope";
import { ReportRunner } from "./runner.service";

export interface GrantIn { email: string; name?: string; reportKeys: string[]; locationIds: string[] | null; rangeKind: "fixed" | "rolling"; rangeFrom?: string | null; rangeTo?: string | null; rollingDays?: number | null; hiddenColumns: string[]; expiresAt?: string | null }
export const factsOf = (g: typeof reportGrant.$inferSelect): GrantFacts => ({ id: g.id, reportKeys: g.reportKeys, locationIds: g.locationIds, rangeKind: g.rangeKind as "fixed" | "rolling", rangeFrom: g.rangeFrom ? String(g.rangeFrom) : null, rangeTo: g.rangeTo ? String(g.rangeTo) : null, rollingDays: g.rollingDays, hiddenColumns: g.hiddenColumns, expiresAt: g.expiresAt, revokedAt: g.revokedAt });

@Injectable()
export class GrantsService {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(AuditService) private audit: AuditService, @Inject(MailService) private mail: MailService, @Inject(ReportRunner) private runner: ReportRunner) {}

  catalog() { return REPORTS.map((r) => ({ key: r.key, title: r.title, description: r.description, groupBys: r.groupBys, columns: r.columns.filter((c) => c.key !== "label").map((c) => ({ key: c.key, label: c.label, sensitive: !!c.sensitive })) })); }

  /** The latest calendar day anywhere the grant reaches: where a rolling window ends today. */
  async todayFor(orgId: string, locationIds: string[] | null): Promise<string> {
    const rows = await this.db.select({ tz: location.timezone }).from(location).where(locationIds ? and(eq(location.orgId, orgId), inArray(location.id, locationIds)) : eq(location.orgId, orgId));
    const utc = new Date().toISOString().slice(0, 10);
    return rows.map((l) => new Intl.DateTimeFormat("en-CA", { timeZone: l.tz }).format(new Date())).reduce((a, b) => (a > b ? a : b), rows.length ? "0000-00-00" : utc);
  }

  async create(orgId: string, actorId: string, v: GrantIn, ip: string | null) {
    const email = v.email.trim().toLowerCase();
    if (!v.reportKeys.length || v.reportKeys.some((k) => !REPORT_KEYS.includes(k))) throw new BadRequestException({ code: "bad_reports" });
    const known = allColumnKeys(); if (v.hiddenColumns.some((c) => c === "label" || !known.includes(c))) throw new BadRequestException({ code: "bad_columns" });
    if (v.locationIds !== null) {
      if (!v.locationIds.length) throw new BadRequestException({ code: "no_locations" });
      const found = await this.db.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, v.locationIds))); if (found.length !== new Set(v.locationIds).size) throw new NotFoundException({ code: "location_not_found" });
    }
    if (v.rangeKind === "fixed" && (!v.rangeFrom || !v.rangeTo || v.rangeTo < v.rangeFrom)) throw new BadRequestException({ code: "bad_range" });
    if (v.rangeKind === "rolling" && !(v.rollingDays && v.rollingDays >= 1 && v.rollingDays <= 366)) throw new BadRequestException({ code: "bad_range" });
    const expires = v.expiresAt ? new Date(v.expiresAt) : null; if (expires && Number.isNaN(expires.getTime())) throw new BadRequestException({ code: "bad_expiry" });
    return this.db.transaction(async (tx) => {
      let [who] = await tx.select().from(user).where(and(eq(user.orgId, orgId), sql`lower(${user.email}) = ${email}`));
      if (!who) [who] = await tx.insert(user).values({ orgId, email, name: (v.name ?? "").trim() || email.split("@")[0]!, portalOnly: true }).returning();
      if (who!.status !== "active") throw new ConflictException({ code: "user_disabled" });
      const [g] = await tx.insert(reportGrant).values({ orgId, granteeUserId: who!.id, reportKeys: v.reportKeys, locationIds: v.locationIds, rangeKind: v.rangeKind, rangeFrom: v.rangeKind === "fixed" ? v.rangeFrom! : null, rangeTo: v.rangeKind === "fixed" ? v.rangeTo! : null,
        rollingDays: v.rangeKind === "rolling" ? v.rollingDays! : null, hiddenColumns: [...new Set(v.hiddenColumns)], expiresAt: expires, createdBy: actorId }).returning();
      await this.audit.record({ orgId, actorId, action: "report_grant.create", subjectType: "report_grant", subjectId: g!.id, after: { grantee: email, reports: v.reportKeys, locations: v.locationIds, rangeKind: v.rangeKind, from: v.rangeFrom ?? null, to: v.rangeTo ?? null, rollingDays: v.rollingDays ?? null, hidden: v.hiddenColumns, expiresAt: expires }, ip }, tx);
      await this.mail.send(orgId, { to: email, kind: "portal_invite", subject: "You can now view reports on Shelfline", body: `You have been given access to ${v.reportKeys.map((k) => REPORTS.find((r) => r.key === k)!.title).join(", ")}.\nOpen ${this.cfg.portalUrl} and sign in with this email address. You will be sent a one-time code each time.` }, tx);
      return { id: g!.id, granteeUserId: who!.id };
    });
  }

  private async names(orgId: string, ids: string[]) { return ids.length ? new Map((await this.db.select({ id: location.id, name: location.name }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, ids)))).map((l) => [l.id, l.name])) : new Map<string, string>(); }

  async list(orgId: string) {
    const rows = await this.db.select({ g: reportGrant, name: user.name, email: user.email }).from(reportGrant).innerJoin(user, eq(user.id, reportGrant.granteeUserId)).where(eq(reportGrant.orgId, orgId)).orderBy(desc(reportGrant.createdAt));
    const by = new Map((await this.db.execute(sql`select grant_id::text as id, count(*)::int as n, max(at) as last from shelfline.report_view_log where org_id = ${orgId} group by grant_id`)).rows.map((r) => [String(r.id), { n: Number(r.n), last: r.last }]));
    const locs = await this.names(orgId, [...new Set(rows.flatMap((r) => r.g.locationIds ?? []))]); const now = new Date();
    return rows.map(({ g, name, email }) => ({ id: g.id, grantee: name, email, reportKeys: g.reportKeys, locations: g.locationIds ? g.locationIds.map((i) => locs.get(i) ?? "?") : null, rangeKind: g.rangeKind, rangeFrom: g.rangeFrom ? String(g.rangeFrom) : null, rangeTo: g.rangeTo ? String(g.rangeTo) : null,
      rollingDays: g.rollingDays, hiddenColumns: g.hiddenColumns, expiresAt: g.expiresAt, createdAt: g.createdAt, status: endedReason(factsOf(g), now) ?? "active", views: by.get(g.id)?.n ?? 0, lastViewAt: by.get(g.id)?.last ?? null }));
  }

  async revoke(orgId: string, actorId: string, id: string, ip: string | null) {
    const [g] = await this.db.select().from(reportGrant).where(and(eq(reportGrant.id, id), eq(reportGrant.orgId, orgId))); if (!g) throw new NotFoundException({ code: "grant_not_found" });
    if (g.revokedAt) throw new ConflictException({ code: "already_revoked" });
    await this.db.transaction(async (tx) => {
      await tx.update(reportGrant).set({ revokedAt: new Date(), revokedBy: actorId }).where(eq(reportGrant.id, id));
      await this.audit.record({ orgId, actorId, action: "report_grant.revoke", subjectType: "report_grant", subjectId: id, ip }, tx);
    });
    return { id, status: "revoked" };
  }

  /** What this person would see, exactly: the same scope and the same runner as the portal, run as an administrator. Not written to the view log. */
  async preview(orgId: string, id: string, key: string, req: { locationId?: string; from?: string; to?: string; groupBy?: string }) {
    const [g] = await this.db.select().from(reportGrant).where(and(eq(reportGrant.id, id), eq(reportGrant.orgId, orgId))); if (!g) throw new NotFoundException({ code: "grant_not_found" });
    const facts = factsOf(g); const today = await this.todayFor(orgId, g.locationIds);
    const scope = ReportScope.fromGrant({ ...facts, expiresAt: null, revokedAt: null }, key, today, new Date());
    return { ...(await this.runner.run(orgId, key, scope, req)), grantStatus: endedReason(facts, new Date()) ?? "active", window: windowOf(facts, today) };
  }

  async views(orgId: string, id: string) {
    const [g] = await this.db.select({ id: reportGrant.id }).from(reportGrant).where(and(eq(reportGrant.id, id), eq(reportGrant.orgId, orgId))); if (!g) throw new NotFoundException({ code: "grant_not_found" });
    const rows = await this.db.select().from(reportViewLog).where(eq(reportViewLog.grantId, id)).orderBy(desc(reportViewLog.id)).limit(200);
    return rows.map((r) => ({ id: r.id, at: r.at, reportKey: r.reportKey, format: r.format, requested: r.requested, served: r.served, rows: r.rowCount }));
  }
}
