import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { locationScope } from "./scope";

const idList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

@Injectable()
export class OrdersService {
  constructor(@Inject(DB) private db: Db, @Inject(AuthzService) private authz: AuthzService) {}

  /** Newest first, keyset-paginated on (effective_at, id). `q` matches receipt number or customer name; `flag` filters to sales carrying that flag. */
  async list(orgId: string, userId: string, o: { locationId?: string; from?: string; to?: string; q?: string; flag?: string; status?: string; limit?: number; before?: string }) {
    const ids = await locationScope(this.authz, userId, "sale:read", o.locationId);
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const like = o.q ? `%${o.q.replace(/[%_\\]/g, "\\$&")}%` : null;
    const cur = o.before ? (JSON.parse(Buffer.from(o.before, "base64url").toString()) as [string, string]) : null;
    const r = await this.db.execute(sql`
      select s.id, s.receipt_no, s.effective_at, s.local_date, s.total_minor, s.discount_minor, s.status, s.flags, l.name as location, reg.code as register, u.name as cashier, c.name as customer,
        (select string_agg(distinct p.tender, ',' order by p.tender) from shelfline.payment p where p.sale_id = s.id) as tenders,
        (select coalesce(sum(qty), 0)::int from shelfline.sale_line sl where sl.sale_id = s.id) as items,
        (select coalesce(sum(total_minor), 0)::int from shelfline.refund rf where rf.sale_id = s.id) as refunded
      from shelfline.sale s join shelfline.location l on l.id = s.location_id join shelfline.register reg on reg.id = s.register_id join shelfline."user" u on u.id = s.cashier_id left join shelfline.customer c on c.id = s.customer_id
      where s.org_id = ${orgId} and ${ids === null ? sql`true` : ids.length ? sql`s.location_id in (${idList(ids)})` : sql`false`}
        ${o.from ? sql`and s.local_date >= ${o.from}::date` : sql``} ${o.to ? sql`and s.local_date <= ${o.to}::date` : sql``}
        ${like ? sql`and (s.receipt_no ilike ${like} or c.name ilike ${like})` : sql``} ${o.flag ? sql`and ${o.flag} = any(s.flags)` : sql``} ${o.status ? sql`and s.status = ${o.status}` : sql``}
        ${cur ? sql`and (s.effective_at, s.id) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)` : sql``}
      order by s.effective_at desc, s.id desc limit ${limit + 1}`);
    const rows = r.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((x) => ({ id: String(x.id), receiptNo: String(x.receipt_no), at: x.effective_at, localDate: String(x.local_date), totalMinor: Number(x.total_minor), discountMinor: Number(x.discount_minor), status: String(x.status), flags: x.flags as string[], location: String(x.location), register: String(x.register), cashier: String(x.cashier), customer: x.customer as string | null, tenders: x.tenders ? String(x.tenders).split(",") : [], items: Number(x.items), refundedMinor: Number(x.refunded) })),
      next: r.rows.length > limit && last ? Buffer.from(JSON.stringify([new Date(last.effective_at as string).toISOString(), last.id])).toString("base64url") : null,
    };
  }

  async detail(orgId: string, userId: string, id: string) {
    const [s] = (await this.db.execute(sql`select s.*, l.name as location_name, reg.code as register_code, u.name as cashier_name, c.name as customer_name, c.id as customer_ref from shelfline.sale s join shelfline.location l on l.id = s.location_id join shelfline.register reg on reg.id = s.register_id join shelfline."user" u on u.id = s.cashier_id left join shelfline.customer c on c.id = s.customer_id where s.id = ${id} and s.org_id = ${orgId}`)).rows as Record<string, any>[];
    if (!s) throw new NotFoundException({ code: "order_not_found" });
    if (!(await this.authz.can(userId, "sale:read", String(s.location_id)))) throw new ForbiddenException({ code: "forbidden", permission: "sale:read" });
    const [lines, pays, refunds, ex] = await Promise.all([
      this.db.execute(sql`select sl.line_no, sl.qty, sl.unit_price_minor, sl.discount_minor, sl.discount_reason, sl.tax_minor, sl.total_minor, sl.refunded_qty, sl.refunded_minor, v.sku, p.title, v.options, ap.name as approved_by from shelfline.sale_line sl join shelfline.variant v on v.id = sl.variant_id join shelfline.product p on p.id = v.product_id left join shelfline."user" ap on ap.id = sl.approved_by where sl.sale_id = ${id} order by sl.line_no`),
      this.db.execute(sql`select tender, amount_minor, change_minor, reference from shelfline.payment where sale_id = ${id} order by id`),
      this.db.execute(sql`select r.id, r.at, r.total_minor, r.tender, r.reason, r.flags, u.name as actor, ap.name as approver from shelfline.refund r join shelfline."user" u on u.id = r.actor_id left join shelfline."user" ap on ap.id = r.approved_by where r.sale_id = ${id} order by r.at`),
      this.db.execute(sql`select id, kind, status, detail, created_at from shelfline.sync_exception where org_id = ${orgId} and (ref_id = ${id} or command_id = ${s.command_id ?? null}) order by created_at`),
    ]);
    return {
      id: String(s.id), receiptNo: String(s.receipt_no), status: String(s.status), at: s.effective_at, clientTs: s.client_ts, receivedAt: s.received_at, localDate: String(s.local_date), location: String(s.location_name), locationId: String(s.location_id), register: String(s.register_code), cashier: String(s.cashier_name),
      customer: s.customer_name ? { id: String(s.customer_ref), name: String(s.customer_name) } : null, flags: s.flags as string[], sessionId: s.session_id as string | null,
      totals: { subtotalMinor: Number(s.subtotal_minor), discountMinor: Number(s.discount_minor), taxMinor: Number(s.tax_minor), totalMinor: Number(s.total_minor), roundingMinor: Number(s.rounding_minor), payableMinor: Number(s.payable_minor), tenderedMinor: Number(s.tendered_minor), changeMinor: Number(s.change_minor) },
      lines: lines.rows.map((l) => ({ lineNo: Number(l.line_no), title: String(l.title), sku: String(l.sku), options: Object.values((l.options ?? {}) as Record<string, string>).join(" · "), qty: Number(l.qty), unitPriceMinor: Number(l.unit_price_minor), discountMinor: Number(l.discount_minor), discountReason: l.discount_reason as string | null, approvedBy: l.approved_by as string | null, taxMinor: Number(l.tax_minor), totalMinor: Number(l.total_minor), refundedQty: Number(l.refunded_qty), refundedMinor: Number(l.refunded_minor) })),
      payments: pays.rows.map((p) => ({ tender: String(p.tender), amountMinor: Number(p.amount_minor), changeMinor: Number(p.change_minor), reference: p.reference as string | null })),
      refunds: refunds.rows.map((r) => ({ id: String(r.id), at: r.at, totalMinor: Number(r.total_minor), tender: String(r.tender), reason: String(r.reason), flags: r.flags as string[], actor: String(r.actor), approver: r.approver as string | null })),
      exceptions: ex.rows.map((e) => ({ id: String(e.id), kind: String(e.kind), status: String(e.status), detail: e.detail, createdAt: e.created_at })),
    };
  }
}
