import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { hashSecret } from "../auth/auth.service";
import { DB, type Db } from "../db/db.module";
import { location, role, rolePermission, staffProfile, user, userAssignment } from "../db/schema";

export interface AssignmentInput { role: string; locationId: string | null }
const isUnique = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505" || (e as { code?: string })?.code === "23505";

@Injectable()
export class UserService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}

  private async resolveAssignments(tx: Db, orgId: string, items: AssignmentInput[]) {
    const keys = [...new Set(items.map((i) => i.role))];
    const roles = keys.length ? await tx.select({ id: role.id, key: role.key }).from(role).where(and(eq(role.orgId, orgId), inArray(role.key, keys))) : [];
    const byKey = new Map(roles.map((r) => [r.key, r.id]));
    const locIds = [...new Set(items.map((i) => i.locationId).filter((x): x is string => !!x))];
    if (locIds.length) {
      const found = await tx.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), inArray(location.id, locIds)));
      if (found.length !== locIds.length) throw new BadRequestException({ code: "unknown_location" });
    }
    return items.map((i) => {
      const roleId = byKey.get(i.role);
      if (!roleId) throw new BadRequestException({ code: "unknown_role", role: i.role });
      return { roleId, locationId: i.locationId };
    });
  }

  async create(orgId: string, actorId: string, v: { email: string; name: string; password?: string; employeeCode?: string; pin?: string; assignments: AssignmentInput[] }, ip: string | null) {
    const passwordHash = v.password ? await hashSecret(v.password) : null;
    const pinHash = v.pin ? await hashSecret(v.pin) : null;
    try {
      return await this.db.transaction(async (tx) => {
        const resolved = await this.resolveAssignments(tx as unknown as Db, orgId, v.assignments);
        const [u] = await tx.insert(user).values({ orgId, email: v.email, name: v.name, passwordHash }).returning({ id: user.id, email: user.email, name: user.name, status: user.status });
        if (v.employeeCode) await tx.insert(staffProfile).values({ userId: u!.id, orgId, employeeCode: v.employeeCode, pinHash });
        if (resolved.length) await tx.insert(userAssignment).values(resolved.map((r) => ({ userId: u!.id, ...r })));
        await this.audit.record({ orgId, actorId, action: "user.create", subjectType: "user", subjectId: u!.id, after: { ...u, employeeCode: v.employeeCode, assignments: v.assignments }, ip }, tx);
        return u!;
      });
    } catch (e) { if (isUnique(e)) throw new ConflictException({ code: "user_exists" }); throw e; }
  }

  /** Users visible to the caller: all if org-wide, otherwise only those with an assignment inside the caller's locations. */
  async list(orgId: string, callerId: string) {
    const s = await this.authz.scope(callerId, "user:read");
    const base = this.db.select({ id: user.id, email: user.email, name: user.name, status: user.status, employeeCode: staffProfile.employeeCode, terminalPersonCode: staffProfile.terminalPersonCode }).from(user)
      .leftJoin(staffProfile, eq(staffProfile.userId, user.id));
    type Row = { id: string; email: string; name: string; status: string; employeeCode: string | null; terminalPersonCode: string | null };
    let rows: Row[];
    if (s.all) rows = await base.where(and(eq(user.orgId, orgId), eq(user.portalOnly, false))).orderBy(asc(user.name));   // report readers are not staff
    else if (!s.locationIds.length) rows = [];
    else rows = await base.where(and(eq(user.orgId, orgId), sql`exists (select 1 from ${userAssignment} ua where ua.user_id = ${user.id} and ua.location_id in (${sql.join(s.locationIds.map((l) => sql`${l}::uuid`), sql`, `)}))`)).orderBy(asc(user.name));
    const ids = rows.map((r) => r.id);
    const asg = ids.length ? await this.db.select({ userId: userAssignment.userId, roleKey: role.key, locationId: userAssignment.locationId }).from(userAssignment).innerJoin(role, eq(role.id, userAssignment.roleId)).where(inArray(userAssignment.userId, ids)) : [];
    return rows.map((r) => ({ ...r, assignments: asg.filter((a) => a.userId === r.id).map((a) => ({ role: a.roleKey, locationId: a.locationId })) }));
  }

  async setAssignments(orgId: string, actorId: string, userId: string, items: AssignmentInput[], ip: string | null) {
    await this.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, userId), eq(user.orgId, orgId))).for("update");
      if (!u) throw new NotFoundException({ code: "user_not_found" });
      const before = await tx.select({ role: role.key, locationId: userAssignment.locationId }).from(userAssignment).innerJoin(role, eq(role.id, userAssignment.roleId)).where(eq(userAssignment.userId, userId));
      const resolved = await this.resolveAssignments(tx as unknown as Db, orgId, items);
      await this.guardLastOwner(tx as unknown as Db, orgId, userId, items);
      await tx.delete(userAssignment).where(eq(userAssignment.userId, userId));
      if (resolved.length) await tx.insert(userAssignment).values(resolved.map((r) => ({ userId, ...r })));
      await this.audit.record({ orgId, actorId, action: "user.assignments", subjectType: "user", subjectId: userId, before, after: items, ip }, tx);
    });
  }

  /** An organisation must always keep an active owner with an organisation-wide assignment. */
  private async guardLastOwner(tx: Db, orgId: string, userId: string, next: AssignmentInput[]) {
    if (next.some((i) => i.role === "owner" && i.locationId === null)) return;
    const owners = await tx.select({ userId: userAssignment.userId }).from(userAssignment).innerJoin(role, eq(role.id, userAssignment.roleId)).innerJoin(user, eq(user.id, userAssignment.userId))
      .where(and(eq(role.orgId, orgId), eq(role.key, "owner"), sql`${userAssignment.locationId} is null`, eq(user.status, "active")));
    if (owners.every((o) => o.userId === userId) && owners.some((o) => o.userId === userId)) throw new ConflictException({ code: "last_owner" });
  }

  async setPin(orgId: string, actorId: string, userId: string, pin: string, ip: string | null) {
    const [sp] = await this.db.select().from(staffProfile).where(and(eq(staffProfile.userId, userId), eq(staffProfile.orgId, orgId)));
    if (!sp) throw new NotFoundException({ code: "staff_profile_not_found" });
    await this.db.update(staffProfile).set({ pinHash: await hashSecret(pin), pinAttempts: 0, pinLockedUntil: null }).where(eq(staffProfile.userId, userId));
    await this.audit.record({ orgId, actorId, action: "user.pin_set", subjectType: "user", subjectId: userId, ip });
  }

  async disable(orgId: string, actorId: string, userId: string, ip: string | null) {
    await this.db.transaction(async (tx) => {
      await this.guardLastOwner(tx as unknown as Db, orgId, userId, []);
      const [u] = await tx.update(user).set({ status: "disabled" }).where(and(eq(user.id, userId), eq(user.orgId, orgId))).returning({ id: user.id });
      if (!u) throw new NotFoundException({ code: "user_not_found" });
      await tx.update(staffProfile).set({ pinHash: null }).where(eq(staffProfile.userId, userId));
      await this.audit.record({ orgId, actorId, action: "user.disable", subjectType: "user", subjectId: userId, ip }, tx);
    });
  }

  async roles(orgId: string) {
    const rows = await this.db.select({ key: role.key, name: role.name, permission: rolePermission.permission }).from(role).leftJoin(rolePermission, eq(rolePermission.roleId, role.id)).where(eq(role.orgId, orgId));
    const m = new Map<string, { key: string; name: string; permissions: string[] }>();
    for (const r of rows) { const e = m.get(r.key) ?? { key: r.key, name: r.name, permissions: [] }; if (r.permission) e.permissions.push(r.permission); m.set(r.key, e); }
    return [...m.values()].map((e) => ({ ...e, permissions: e.permissions.sort() }));
  }
}
