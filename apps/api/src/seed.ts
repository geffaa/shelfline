import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { hashSecret } from "./auth/auth.service";
import { SYSTEM_ROLES } from "./auth/permissions";
import * as s from "./db/schema";

/** Creates (idempotently) the organisation, system roles and, from env, the first owner. */
export const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export async function seedOrg(db: ReturnType<typeof drizzle<typeof s>>, o: { orgName: string; slug?: string; currency: string; timezone: string; ownerEmail: string; ownerPassword: string; ownerName?: string }) {
  return db.transaction(async (tx) => {
    let [org] = await tx.select().from(s.org).where(eq(s.org.name, o.orgName));
    if (!org) [org] = await tx.insert(s.org).values({ name: o.orgName, slug: o.slug ?? slugify(o.orgName), currency: o.currency, timezoneDefault: o.timezone }).returning();
    for (const [key, r] of Object.entries(SYSTEM_ROLES)) {
      let [row] = await tx.select().from(s.role).where(and(eq(s.role.orgId, org!.id), eq(s.role.key, key)));
      if (!row) [row] = await tx.insert(s.role).values({ orgId: org!.id, key, name: r.name, system: true }).returning();
      await tx.delete(s.rolePermission).where(eq(s.rolePermission.roleId, row!.id));
      await tx.insert(s.rolePermission).values(r.permissions.map((permission) => ({ roleId: row!.id, permission })));
    }
    let [owner] = await tx.select().from(s.user).where(and(eq(s.user.orgId, org!.id), eq(s.user.email, o.ownerEmail.toLowerCase())));
    if (!owner) {
      [owner] = await tx.insert(s.user).values({ orgId: org!.id, email: o.ownerEmail.toLowerCase(), name: o.ownerName ?? "Owner", passwordHash: await hashSecret(o.ownerPassword) }).returning();
      const [ownerRole] = await tx.select().from(s.role).where(and(eq(s.role.orgId, org!.id), eq(s.role.key, "owner")));
      await tx.insert(s.userAssignment).values({ userId: owner!.id, roleId: ownerRole!.id, locationId: null });
    }
    return { orgId: org!.id, ownerId: owner!.id };
  });
}

if (/(^|[\\/])seed\.ts$/.test(process.argv[1] ?? "")) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline" });
  const db = drizzle(pool, { schema: s });
  // Run it again with ORG_NAME / ORG_SLUG / ORG_CURRENCY / ORG_TIMEZONE / OWNER_EMAIL to add another organisation to the same deployment.
  seedOrg(db, { orgName: process.env.ORG_NAME ?? "Kestrel Run Co.", slug: process.env.ORG_SLUG, currency: process.env.ORG_CURRENCY ?? "AUD", timezone: process.env.ORG_TIMEZONE ?? "Australia/Melbourne", ownerEmail: process.env.OWNER_EMAIL ?? "owner@example.test", ownerPassword: process.env.OWNER_PASSWORD ?? "" , ownerName: "Elena R." })
    .then((r) => { console.log("seeded", r); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
