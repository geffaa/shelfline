import { logConsent } from "../marketing/consent";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { customer } from "../db/schema";

const isUnique = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "23505" || (e as { code?: string })?.code === "23505";

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}

  async list(orgId: string, q: string | undefined, limit = 100) {
    const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
    const r = await this.db.execute(sql`
      select c.id, c.name, c.email, c.phone, c.created_at, c.marketing_consent, count(s.id)::int as orders, coalesce(sum(s.total_minor), 0)::int as spent, max(s.effective_at) as last_at
      from shelfline.customer c left join shelfline.sale s on s.customer_id = c.id where c.org_id = ${orgId} ${like ? sql`and (c.name ilike ${like} or c.email ilike ${like} or c.phone ilike ${like})` : sql``}
      group by c.id order by c.name limit ${Math.min(limit, 500)}`);
    return r.rows.map((x) => ({ id: String(x.id), name: String(x.name), email: x.email as string | null, phone: x.phone as string | null, createdAt: x.created_at, marketingConsent: x.marketing_consent, orders: Number(x.orders), spentMinor: Number(x.spent), lastPurchaseAt: x.last_at }));
  }

  async detail(orgId: string, id: string) {
    const [c] = await this.db.select().from(customer).where(and(eq(customer.id, id), eq(customer.orgId, orgId)));
    if (!c) throw new NotFoundException({ code: "customer_not_found" });
    const recent = await this.db.execute(sql`select s.id, s.receipt_no, s.effective_at, s.total_minor, l.name as location from shelfline.sale s join shelfline.location l on l.id = s.location_id where s.customer_id = ${id} order by s.effective_at desc limit 20`);
    const [agg] = (await this.db.execute(sql`select count(*)::int as n, coalesce(sum(total_minor), 0)::int as spent from shelfline.sale where customer_id = ${id}`)).rows as { n: number; spent: number }[];
    return { ...c, orders: Number(agg!.n), spentMinor: Number(agg!.spent), recent: recent.rows.map((s) => ({ id: String(s.id), receiptNo: String(s.receipt_no), at: s.effective_at, totalMinor: Number(s.total_minor), location: String(s.location) })) };
  }

  async create(orgId: string, actorId: string, v: { name: string; email?: string; phone?: string; notes?: string; marketingConsent?: { email?: boolean; sms?: boolean }; birthMonth?: number; birthDay?: number }, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(customer).values({ id: crypto.randomUUID(), orgId, name: v.name, email: v.email ?? null, phone: v.phone ?? null, notes: v.notes ?? null, marketingConsent: (v.marketingConsent ?? {}) as never, birthMonth: v.birthMonth ?? null, birthDay: v.birthDay ?? null }).returning();
        await logConsent(tx, { orgId, customerId: row!.id, before: undefined, after: v.marketingConsent, source: "admin", actorId });
        await this.audit.record({ orgId, actorId, action: "customer.create", subjectType: "customer", subjectId: row!.id, after: { name: row!.name }, ip }, tx);
        return row!;
      });
    } catch (e) { if (isUnique(e)) throw new ConflictException({ code: "customer_email_exists" }); throw e; }
  }

  async update(orgId: string, actorId: string, id: string, patch: Partial<{ name: string; email: string | null; phone: string | null; notes: string | null; marketingConsent: { email?: boolean; sms?: boolean }; birthMonth: number | null; birthDay: number | null }>, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx.select().from(customer).where(and(eq(customer.id, id), eq(customer.orgId, orgId))).for("update");
        if (!before) throw new NotFoundException({ code: "customer_not_found" });
        const [after] = await tx.update(customer).set({ ...patch, marketingConsent: (patch.marketingConsent ?? before.marketingConsent) as never, updatedAt: new Date() }).where(eq(customer.id, id)).returning();
        await logConsent(tx, { orgId, customerId: id, before: before.marketingConsent as { email?: boolean }, after: after!.marketingConsent as { email?: boolean }, source: "admin", actorId });
        await this.audit.record({ orgId, actorId, action: "customer.update", subjectType: "customer", subjectId: id, before, after, ip }, tx);
        return after!;
      });
    } catch (e) { if (isUnique(e)) throw new ConflictException({ code: "customer_email_exists" }); throw e; }
  }
}
