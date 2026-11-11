import { ForbiddenException } from "@nestjs/common";
import type { AuthzService } from "../auth/authz.service";
import type { Permission } from "../auth/permissions";

/** Resolves which locations a caller may read for `permission`, optionally narrowed to one. null = every location in the organisation. */
export async function locationScope(authz: AuthzService, userId: string, permission: Permission, locationId?: string): Promise<string[] | null> {
  const s = await authz.scope(userId, permission);
  if (locationId) { if (!s.all && !s.locationIds.includes(locationId)) throw new ForbiddenException({ code: "forbidden", permission, locationId }); return [locationId]; }
  return s.all ? null : s.locationIds;
}
