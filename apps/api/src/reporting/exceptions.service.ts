import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { locationScope } from "./scope";

const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

/** Anomalies the server accepted but a person should look at (negative stock, price mismatch, unapproved discount, late sale, ...). */
@Injectable()
export class ExceptionsService {
  constructor(@Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService, @Inject(AuditService) private audit: AuditService) {}

  async list(orgId: string, userId: string, o: { locationId?: string; status?: string; kind?: string; limit?: number }) {
    const ids = await locationScope(this.authz, userId, "sale:read", o.locationId);
    const r = await this.db.execute(sql`
      select e.id, e.kind, e.ref_type, e.ref_id, e.detail, e.status, e.created_at, e.resolved_at, d.name as device, l.id as location_id, l.name as location, s.receipt_no
      from shelfline.sync_exception e join shelfline.device d on d.id = e.device_id join shelfline.location l on l.id = d.location_id left join shelfline.sale s on s.id::text = e.ref_id and e.ref_type = 'sale'
      where e.org_id = ${orgId} and e.status = ${o.status === "resolved" ? "resolved" : "open"} ${o.kind ? sql`and e.kind = ${o.kind}` : sql``}
        and ${ids === null ? sql`true` : ids.length ? sql`l.id in (${idList(ids)})` : sql`false`} order by e.created_at desc limit ${Math.min(o.limit ?? 100, 300)}`);
    return r.rows.map((x) => ({ id: String(x.id), kind: String(x.kind), refType: x.ref_type as string | null, refId: x.ref_id as string | null, receiptNo: x.receipt_no as string | null, detail: x.detail, status: String(x.status), createdAt: x.created_at, resolvedAt: x.resolved_at, device: String(x.device), locationId: String(x.location_id), location: String(x.location) }));
  }

  async resolve(orgId: string, userId: string, id: string, ip: string | null) {
    const [e] = (await this.db.execute(sql`select e.id, e.kind, d.location_id from shelfline.sync_exception e join shelfline.device d on d.id = e.device_id where e.id = ${id} and e.org_id = ${orgId}`)).rows as { id: string; kind: string; location_id: string }[];
    if (!e) throw new NotFoundException({ code: "exception_not_found" });
    if (!(await this.authz.can(userId, "cash:approve", e.location_id))) throw new ForbiddenException({ code: "forbidden", permission: "cash:approve" });
    await this.db.execute(sql`update shelfline.sync_exception set status = 'resolved', resolved_by = ${userId}, resolved_at = now() where id = ${id}`);
    await this.audit.record({ orgId, actorId: userId, action: "sync.exception_resolved", subjectType: "sync_exception", subjectId: id, after: { kind: e.kind }, ip });
  }
}
