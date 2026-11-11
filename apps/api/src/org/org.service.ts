import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { newDeviceKey, sha256Hex } from "../common/crypto";
import { DB, type Db } from "../db/db.module";
import { device, location, register, registerSession } from "../db/schema";

const isUnique = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505" || (e as { code?: string })?.code === "23505";

@Injectable()
export class OrgService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}

  async createLocation(orgId: string, actorId: string, v: { code: string; name: string; type: string; timezone: string; dayCutoff?: string; taxRegion?: string }, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(location).values({ orgId, ...v }).returning();
        await this.audit.record({ orgId, actorId, action: "location.create", subjectType: "location", subjectId: row!.id, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { if (isUnique(e)) throw new ConflictException({ code: "location_code_taken" }); throw e; }
  }

  async listLocations(orgId: string, userId: string) {
    const s = await this.authz.scope(userId, "location:read");
    const q = this.db.select().from(location);
    const notTransit = sql`${location.type} <> 'transit'`;   // per-transfer transit locations are bookkeeping, not places
    const rows = s.all ? await q.where(and(eq(location.orgId, orgId), notTransit)).orderBy(asc(location.name))
      : s.locationIds.length ? await q.where(and(eq(location.orgId, orgId), notTransit, inArray(location.id, s.locationIds))).orderBy(asc(location.name)) : [];
    return rows;
  }

  async getLocation(orgId: string, id: string) {
    const [row] = await this.db.select().from(location).where(and(eq(location.orgId, orgId), eq(location.id, id)));
    if (!row) throw new NotFoundException({ code: "location_not_found" });
    return row;
  }

  async updateLocation(orgId: string, actorId: string, id: string, patch: Partial<{ name: string; timezone: string; dayCutoff: string; taxRegion: string; status: string; cashierDiscountLimitBp: number; cashierRefundLimitMinor: number; cashVarianceLimitMinor: number; giftCardOffline: boolean; giftCardOfflineCapMinor: number; pickupEnabled: boolean }>, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(location).where(and(eq(location.orgId, orgId), eq(location.id, id))).for("update");
      if (!before) throw new NotFoundException({ code: "location_not_found" });
      if (patch.status === "inactive") {
        const open = await tx.select({ id: registerSession.id }).from(registerSession).where(and(eq(registerSession.locationId, id), eq(registerSession.status, "open"))).limit(1);
        if (open.length) throw new ConflictException({ code: "open_sessions", message: "Close the open register sessions first" });
      }
      const [after] = await tx.update(location).set(patch).where(eq(location.id, id)).returning();
      await this.audit.record({ orgId, actorId, action: "location.update", subjectType: "location", subjectId: id, before, after, ip }, tx);
      return after!;
    });
  }

  async createRegister(orgId: string, actorId: string, locationId: string, v: { code: string; name: string }, ip: string | null) {
    await this.getLocation(orgId, locationId);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(register).values({ orgId, locationId, ...v }).returning();
        await this.audit.record({ orgId, actorId, action: "register.create", subjectType: "register", subjectId: row!.id, after: row, ip }, tx);
        return row!;
      });
    } catch (e) { if (isUnique(e)) throw new ConflictException({ code: "register_code_taken" }); throw e; }
  }

  listRegisters(orgId: string, locationId: string) {
    return this.db.select().from(register).where(and(eq(register.orgId, orgId), eq(register.locationId, locationId))).orderBy(asc(register.code));
  }

  /** The plaintext key is returned once; only its SHA-256 is stored. */
  async createDevice(orgId: string, actorId: string, v: { kind: "pos" | "bridge" | "terminal" | "printer"; locationId: string; registerId?: string; name: string; serial?: string }, ip: string | null) {
    await this.getLocation(orgId, v.locationId);
    const key = newDeviceKey();
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(device).values({ orgId, ...v, keyHash: sha256Hex(key) }).returning();
      const { keyHash: _omit, ...safe } = row!;
      await this.audit.record({ orgId, actorId, action: "device.create", subjectType: "device", subjectId: row!.id, after: safe, ip }, tx);
      return { ...safe, key };
    });
  }

  async revokeDevice(orgId: string, actorId: string, id: string, ip: string | null) {
    const [row] = await this.db.update(device).set({ status: "revoked" }).where(and(eq(device.orgId, orgId), eq(device.id, id))).returning({ id: device.id });
    if (!row) throw new NotFoundException({ code: "device_not_found" });
    await this.audit.record({ orgId, actorId, action: "device.revoke", subjectType: "device", subjectId: id, ip });
  }

  async listDevices(orgId: string, locationId: string) {
    const rows = await this.db.select().from(device).where(and(eq(device.orgId, orgId), eq(device.locationId, locationId)));
    return rows.map(({ keyHash: _k, ...d }) => d);
  }
}
