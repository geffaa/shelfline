import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { role, rolePermission, userAssignment } from "../db/schema";
import type { Permission } from "./permissions";

export interface Scope { all: boolean; locationIds: string[] }

/** Roles are read from the database on every call: a changed or revoked role applies to the next request. */
@Injectable()
export class AuthzService {
  constructor(@Inject(DB) private db: Db) {}

  async scope(userId: string, permission: Permission, db: Pick<Db, "select"> = this.db): Promise<Scope> {
    const rows = await db
      .select({ locationId: userAssignment.locationId })
      .from(userAssignment)
      .innerJoin(role, eq(role.id, userAssignment.roleId))
      .innerJoin(rolePermission, and(eq(rolePermission.roleId, role.id), eq(rolePermission.permission, permission)))
      .where(eq(userAssignment.userId, userId));
    if (rows.some((r) => r.locationId === null)) return { all: true, locationIds: [] };
    return { all: false, locationIds: [...new Set(rows.map((r) => r.locationId!))] };
  }

  /** locationId omitted = organisation-wide action: only an assignment without a location qualifies. */
  async can(userId: string, permission: Permission, locationId?: string | null, db: Pick<Db, "select"> = this.db): Promise<boolean> {
    const s = await this.scope(userId, permission, db);
    if (s.all) return true;
    return !!locationId && s.locationIds.includes(locationId);
  }
}
