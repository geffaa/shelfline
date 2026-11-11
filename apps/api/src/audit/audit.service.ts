import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { auditLog, user } from "../db/schema";

export interface AuditEntry {
  orgId: string; actorId?: string | null; actorKind?: "user" | "device" | "system";
  action: string; subjectType?: string; subjectId?: string; before?: unknown; after?: unknown; detail?: unknown;
  ip?: string | null; deviceId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private db: Db) {}

  /** Pass `tx` to write inside the caller's transaction so the audit row commits atomically with the change. */
  async record(e: AuditEntry, tx: Pick<Db, "insert"> = this.db) {
    await tx.insert(auditLog).values({
      orgId: e.orgId, actorId: e.actorId ?? null, actorKind: e.actorKind ?? "user", action: e.action,
      subjectType: e.subjectType, subjectId: e.subjectId, before: e.before ?? null, after: e.after ?? null,
      detail: e.detail ?? null, ip: e.ip ?? null, deviceId: e.deviceId ?? null,
    });
  }

  list(orgId: string, opts: { action?: string; beforeId?: number; limit?: number; actorId?: string; subjectType?: string; subjectId?: string; from?: string; to?: string }) {
    const conds = [eq(auditLog.orgId, orgId)];
    if (opts.action) conds.push(eq(auditLog.action, opts.action));
    if (opts.actorId) conds.push(eq(auditLog.actorId, opts.actorId));
    if (opts.subjectType) conds.push(eq(auditLog.subjectType, opts.subjectType));
    if (opts.subjectId) conds.push(eq(auditLog.subjectId, opts.subjectId));
    if (opts.from) conds.push(gte(auditLog.at, new Date(`${opts.from}T00:00:00Z`)));
    if (opts.to) conds.push(lte(auditLog.at, new Date(`${opts.to}T23:59:59.999Z`)));
    if (opts.beforeId) conds.push(lt(auditLog.id, opts.beforeId));
    return this.db.select({ id: auditLog.id, orgId: auditLog.orgId, actorId: auditLog.actorId, actorKind: auditLog.actorKind, actorName: user.name, action: auditLog.action, subjectType: auditLog.subjectType, subjectId: auditLog.subjectId, before: auditLog.before, after: auditLog.after, detail: auditLog.detail, at: auditLog.at, ip: auditLog.ip, deviceId: auditLog.deviceId })
      .from(auditLog).leftJoin(user, eq(user.id, auditLog.actorId)).where(and(...conds)).orderBy(desc(auditLog.id)).limit(Math.min(opts.limit ?? 50, 200));
  }
}
