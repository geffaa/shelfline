import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { MIN_SCHEMA_V, SCHEMA_V, type CommandResult, type PullResponse, type PushRequest, type PushResponse, type ReplicaEntityType, type ReplicaItem, type SnapshotResponse } from "@shelfline/contracts";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { device, syncCommandReceipt, syncException, user, userAssignment } from "../db/schema";
import { CommandRegistry, type DeviceRow } from "./commands";
import { loadEntities, snapshotKey, snapshotPage, SNAPSHOT_ORDER } from "./replica";

const MAX_SKEW_MS = 5 * 60_000;
const PAGE = 500;

const parseCursor = (c: string): [string, number] => {
  const m = /^(\d{1,20}):(-?\d{1,18})$/.exec(c);
  if (!m) throw new BadRequestException({ code: "bad_cursor" });
  return [m[1]!, Number(m[2])];
};

@Injectable()
export class SyncService {
  constructor(@Inject(DB) private db: Db, @Inject(CommandRegistry) private registry: CommandRegistry, @Inject(AuthzService) private authz: AuthzService, @Inject(AuditService) private audit: AuditService) {}

  async deviceFor(orgId: string, deviceId: string | undefined): Promise<DeviceRow> {
    const [d] = deviceId ? await this.db.select().from(device).where(and(eq(device.id, deviceId), eq(device.orgId, orgId))) : [];
    if (!d || d.status !== "active" || d.kind !== "pos") throw new ForbiddenException({ code: "device_required" });
    // Every poll proves the till is alive; write at most every 30 s so the Today screen can show offline tills without a write per request.
    if (!d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > 30_000) await this.db.update(device).set({ lastSeenAt: new Date() }).where(eq(device.id, d.id));
    return d;
  }

  private async horizon(): Promise<string> {
    const r = await this.db.execute(sql`select pg_snapshot_xmin(pg_current_snapshot())::text as h`);
    return String((r.rows[0] as { h: string }).h);
  }

  // ------------------------------------------------------------------ pull
  /**
   * Cursor is "<txid>:<seq>". A row is served only if its transaction id is below the oldest transaction still in progress
   * (pg_snapshot_xmin), so every transaction that could still commit a lower-numbered row has already finished. Rows are ordered by
   * (txid, seq), not by seq alone: a transaction with a lower txid can take a higher seq, so seq order is not commit order.
   */
  async pull(d: DeviceRow, cursor: string, limit = PAGE): Promise<PullResponse> {
    const [ctx, cseq] = parseCursor(cursor);
    const horizon = await this.horizon();
    const rows = (await this.db.execute(sql`
      select seq, txid::text as txid, entity_type, entity_id, op from shelfline.change_log
      where org_id = ${d.orgId} and (location_id is null or location_id = ${d.locationId})
        and (txid, seq) > (${ctx}::xid8, ${cseq}::bigint) and txid < ${horizon}::xid8
      order by txid, seq limit ${Math.min(limit, 2000) + 1}`)).rows as { seq: string; txid: string; entity_type: ReplicaEntityType; entity_id: string; op: "upsert" | "delete" }[];
    const hasMore = rows.length > Math.min(limit, 2000);
    const page = hasMore ? rows.slice(0, -1) : rows;

    // Coalesce: the latest operation per entity wins; current state is read once per type.
    const last = new Map<string, { type: ReplicaEntityType; id: string; op: "upsert" | "delete" }>();
    for (const r of page) last.set(`${r.entity_type}|${r.entity_id}`, { type: r.entity_type, id: r.entity_id, op: r.op });
    const byType = new Map<ReplicaEntityType, string[]>();
    for (const e of last.values()) if (e.op === "upsert") (byType.get(e.type) ?? byType.set(e.type, []).get(e.type)!).push(e.id);
    const loaded = new Map<string, Record<string, unknown>>();
    for (const [type, ids] of byType) for (const [id, data] of await loadEntities(this.db, d.orgId, d.locationId, type, ids)) loaded.set(`${type}|${id}`, data);
    const items: ReplicaItem[] = [];
    for (const e of last.values()) {
      const data = e.op === "upsert" ? loaded.get(`${e.type}|${e.id}`) : undefined;
      items.push(data ? { type: e.type, id: e.id, op: "upsert", data } : { type: e.type, id: e.id, op: "delete" });
    }
    let next: string;
    if (hasMore) { const l = page[page.length - 1]!; next = `${l.txid}:${l.seq}`; }
    else { next = `${horizon}:-1`; if (BigInt(horizon) < BigInt(ctx)) next = cursor; }
    return { cursor: next, items, hasMore, serverTime: new Date().toISOString() };
  }

  /** Initial download, one entity type per page. The cursor is taken before any data is read, so nothing committed after it is missed. */
  async snapshot(d: DeviceRow, after: string | null, limit = 1000): Promise<SnapshotResponse> {
    const cursor = after ? null : `${await this.horizon()}:-1`;
    let ti = 0; let afterId: string | null = null;
    if (after) { const [t, id] = after.split("|"); ti = Number(t); afterId = id || null; if (!Number.isInteger(ti) || ti < 0 || ti >= SNAPSHOT_ORDER.length) throw new BadRequestException({ code: "bad_cursor" }); }
    for (; ti < SNAPSHOT_ORDER.length; ti++, afterId = null) {
      const type = SNAPSHOT_ORDER[ti]!;
      const items = await snapshotPage(this.db, d.orgId, d.locationId, type, afterId, limit);
      if (items.length === 0) continue;
      const lastKey = snapshotKey(type, items[items.length - 1]!);
      const more = items.length === limit;
      const nextType = more ? ti : ti + 1;
      return { cursor, items, next: more ? `${ti}|${lastKey}` : nextType < SNAPSHOT_ORDER.length ? `${nextType}|` : null, serverTime: new Date().toISOString() };
    }
    return { cursor, items: [], next: null, serverTime: new Date().toISOString() };
  }

  // ------------------------------------------------------------------ push
  async push(d0: DeviceRow, req: PushRequest): Promise<PushResponse> {
    const serverNow = new Date();
    const skewMs = Date.parse(req.deviceNow) - serverNow.getTime();
    await this.db.update(device).set({ lastSeenAt: serverNow, clockSkewMs: Math.max(-2_000_000_000, Math.min(2_000_000_000, Math.round(skewMs))), ...(req.queued !== undefined ? { queuedCount: req.queued, queuedAt: serverNow } : {}) }).where(eq(device.id, d0.id));
    const results: CommandResult[] = []; let halted = false;
    for (const cmd of [...req.commands].sort((a, b) => a.seq - b.seq)) {
      try {
        const r = await this.processOne(d0.id, cmd, skewMs, serverNow);
        results.push(r);
        if (r.status === "gap") break;
      } catch (e) {
        // Unexpected failure: nothing was recorded for this command, so the device resends it (and later ones) from expectedSeq.
        halted = true; if (!(e instanceof HttpException)) console.error("sync: command failed unexpectedly", cmd.type, e);
        break;
      }
    }
    const [dev] = await this.db.select({ lastSeq: device.lastSeq }).from(device).where(eq(device.id, d0.id));
    return { serverTime: serverNow.toISOString(), skewMs, results, expectedSeq: (dev?.lastSeq ?? 0) + 1, ...(halted ? { halted } : {}) };
  }

  private async processOne(deviceId: string, cmd: PushRequest["commands"][number], skewMs: number, serverNow: Date): Promise<CommandResult> {
    return this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(device).where(eq(device.id, deviceId)).for("update"); // serialises overlapping pushes from one device
      if (!d || d.status !== "active") throw new ForbiddenException({ code: "device_revoked" });
      const [seen] = await tx.select().from(syncCommandReceipt).where(eq(syncCommandReceipt.commandId, cmd.id));
      if (seen) return { id: cmd.id, seq: cmd.seq, status: "duplicate", reason: seen.reason ?? undefined, flags: seen.flags, result: seen.result ?? undefined, detail: { original: seen.status } };
      if (cmd.seq <= d.lastSeq) return { id: cmd.id, seq: cmd.seq, status: "rejected", reason: "seq_reused" };
      if (cmd.seq > d.lastSeq + 1) return { id: cmd.id, seq: cmd.seq, status: "gap", detail: { expected: d.lastSeq + 1 } };

      const skewed = Math.abs(skewMs) > MAX_SKEW_MS;
      const clientTs = new Date(cmd.clientTs);
      const at = skewed ? serverNow : new Date(clientTs.getTime() - skewMs);
      const baseFlags: string[] = skewed ? ["skewed_clock"] : [];
      const record = async (status: "accepted" | "accepted_flagged" | "rejected", extra: { reason?: string; result?: unknown; flags?: string[]; exceptions?: { kind: string; refType?: string; refId?: string; detail?: unknown }[] } = {}) => {
        const flags = [...new Set([...(extra.flags ?? []), ...baseFlags])];
        const final = status === "rejected" ? "rejected" : flags.length ? "accepted_flagged" : "accepted";
        await tx.insert(syncCommandReceipt).values({ commandId: cmd.id, orgId: d.orgId, deviceId: d.id, deviceSeq: cmd.seq, type: cmd.type, actorId: cmd.actorId, status: final, reason: extra.reason ?? null, result: (extra.result ?? null) as never, flags, clientTs, effectiveAt: at });
        const kinds = new Set((extra.exceptions ?? []).map((x) => x.kind));
        const ex = [...(extra.exceptions ?? []), ...flags.filter((f) => !kinds.has(f)).map((kind) => ({ kind, refType: "command", refId: cmd.id, detail: undefined as unknown }))];
        if (ex.length) await tx.insert(syncException).values(ex.map((x) => ({ orgId: d.orgId, kind: x.kind, refType: x.refType ?? "command", refId: x.refId ?? cmd.id, deviceId: d.id, commandId: cmd.id, detail: (x.detail ?? { type: cmd.type, seq: cmd.seq }) as never })));
        await tx.update(device).set({ lastSeq: cmd.seq }).where(eq(device.id, d.id));
        return { id: cmd.id, seq: cmd.seq, status: final, reason: extra.reason, flags: flags.length ? flags : undefined, result: extra.result } as CommandResult;
      };
      const reject = (reason: string, detail?: unknown) => record("rejected", { reason, result: detail });

      if (cmd.schemaV < MIN_SCHEMA_V) return reject("update_required", { minSchemaV: MIN_SCHEMA_V, schemaV: cmd.schemaV });
      if (cmd.schemaV > SCHEMA_V) return reject("unsupported_schema", { schemaV: cmd.schemaV, supported: SCHEMA_V });
      const [actor] = await tx.select({ status: user.status }).from(user).where(and(eq(user.id, cmd.actorId), eq(user.orgId, d.orgId)));
      const asg = actor ? await tx.select({ l: userAssignment.locationId }).from(userAssignment).where(eq(userAssignment.userId, cmd.actorId)) : [];
      if (!actor || actor.status !== "active" || !asg.some((a) => a.l === null || a.l === d.locationId)) return reject("actor_not_assigned");
      const handler = this.registry.get(cmd.type);
      if (!handler) return reject("unknown_command", { type: cmd.type });
      const parsed = handler.schema.safeParse(cmd.payload);
      if (!parsed.success) return reject("invalid_payload", { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) });
      if (handler.permission && !(await this.authz.can(cmd.actorId, handler.permission, d.locationId, tx))) return reject("forbidden", { permission: handler.permission });

      try {
        // A savepoint: a business refusal rolls back the handler's partial effects but the command is still recorded.
        const out = await tx.transaction((sp) => handler.handle({ tx: sp, orgId: d.orgId, actorId: cmd.actorId, device: d, at, commandId: cmd.id }, parsed.data));
        return record(out.flags?.length || out.exceptions?.length ? "accepted_flagged" : "accepted", { result: out.result, flags: out.flags, exceptions: out.exceptions });
      } catch (e) {
        if (e instanceof HttpException && e.getStatus() >= 400 && e.getStatus() < 500) {
          const body = e.getResponse() as { code?: string };
          return reject(typeof body === "object" && body.code ? body.code : "refused", typeof body === "object" ? body : undefined);
        }
        throw e;
      }
    });
  }

  // ------------------------------------------------------------------ exceptions (read side for S20/S22, resolved by managers)
  listExceptions(orgId: string, status: "open" | "resolved" = "open") {
    return this.db.select().from(syncException).where(and(eq(syncException.orgId, orgId), eq(syncException.status, status))).orderBy(desc(syncException.createdAt)).limit(200);
  }
  async resolveException(orgId: string, actorId: string, id: string, ip: string | null) {
    const [row] = await this.db.update(syncException).set({ status: "resolved", resolvedBy: actorId, resolvedAt: new Date() }).where(and(eq(syncException.id, id), eq(syncException.orgId, orgId))).returning();
    if (!row) throw new NotFoundException({ code: "exception_not_found" });
    await this.audit.record({ orgId, actorId, action: "sync.exception_resolved", subjectType: "sync_exception", subjectId: id, after: { kind: row.kind }, ip });
    return row;
  }
  status(d: DeviceRow) { return { deviceId: d.id, lastSeq: d.lastSeq, expectedSeq: d.lastSeq + 1, clockSkewMs: d.clockSkewMs, serverTime: new Date().toISOString(), schemaV: SCHEMA_V, minSchemaV: MIN_SCHEMA_V }; }
}
void asc;
