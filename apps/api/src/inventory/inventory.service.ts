import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { location, product, stockBalance, stockMovement, variant } from "../db/schema";
import { LedgerService } from "./ledger.service";

export const ADJUST_REASONS = ["counting_error", "damaged", "theft_or_shrinkage", "supplier_short_shipment", "found", "other"] as const;
const STOCKED_TYPES = new Set(["store", "warehouse"]);

@Injectable()
export class InventoryService {
  constructor(@Inject(DB) private db: Db, @Inject(LedgerService) private ledger: LedgerService, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}

  private async stockedLocation(orgId: string, id: string) {
    const [l] = await this.db.select().from(location).where(and(eq(location.id, id), eq(location.orgId, orgId)));
    if (!l) throw new NotFoundException({ code: "location_not_found" });
    if (!STOCKED_TYPES.has(l.type) || l.status !== "active") throw new BadRequestException({ code: "location_cannot_hold_stock", type: l.type, status: l.status });
    return l;
  }

  async receive(orgId: string, actorId: string, v: { locationId: string; reference?: string; idempotencyKey: string; lines: { variantId: string; qty: number; unitCostMinor: number }[] }, ip: string | null) {
    await this.stockedLocation(orgId, v.locationId);
    return this.db.transaction(async (tx) => {
      const r = await this.ledger.appendIn(tx, orgId, actorId, v.lines.map((l, i) => ({ variantId: l.variantId, locationId: v.locationId, qtyDelta: l.qty, kind: "manual_receive" as const, sourceType: "manual_receive", sourceId: v.idempotencyKey, lineNo: i, unitCostMinor: l.unitCostMinor, note: v.reference })));
      if (r.applied) await this.audit.record({ orgId, actorId, action: "inventory.receive", subjectType: "location", subjectId: v.locationId, after: { lines: v.lines, reference: v.reference, idempotencyKey: v.idempotencyKey }, ip }, tx);
      return r;
    });
  }

  async adjust(orgId: string, actorId: string, v: { locationId: string; variantId: string; qtyDelta: number; reason: (typeof ADJUST_REASONS)[number]; note?: string; idempotencyKey: string }, ip: string | null) {
    await this.stockedLocation(orgId, v.locationId);
    return this.db.transaction(async (tx) => {
      const r = await this.ledger.appendIn(tx, orgId, actorId, [{ variantId: v.variantId, locationId: v.locationId, qtyDelta: v.qtyDelta, kind: "manual_adjust", sourceType: "manual_adjust", sourceId: v.idempotencyKey, reason: v.reason, note: v.note }]);
      if (r.applied) await this.audit.record({ orgId, actorId, action: "inventory.adjust", subjectType: "variant", subjectId: v.variantId, after: { locationId: v.locationId, qtyDelta: v.qtyDelta, reason: v.reason, note: v.note }, ip }, tx);
      return r;
    });
  }

  /** Balances for the caller's locations. Cost is removed unless the caller holds cost:read in that location. */
  async list(orgId: string, userId: string, o: { locationId?: string; variantId?: string; q?: string; limit?: number }) {
    const scope = await this.authz.scope(userId, "inventory:read");
    const costScope = await this.authz.scope(userId, "cost:read");
    const conds = [eq(stockBalance.orgId, orgId)];
    if (!scope.all) { if (!scope.locationIds.length) return []; conds.push(inArray(stockBalance.locationId, scope.locationIds)); }
    if (o.locationId) conds.push(eq(stockBalance.locationId, o.locationId));
    if (o.variantId) conds.push(eq(stockBalance.variantId, o.variantId));
    if (o.q) { const like = `%${o.q.replace(/[%_\\]/g, "\\$&")}%`; conds.push(sql`(${variant.sku} ilike ${like} or ${product.title} ilike ${like} or ${variant.barcode} = ${o.q})`); }
    const rows = await this.db.select({ variantId: stockBalance.variantId, locationId: stockBalance.locationId, onHand: stockBalance.onHand, reserved: stockBalance.reserved, incoming: stockBalance.incoming, avgCostMinor: stockBalance.avgCostMinor, sku: variant.sku, title: product.title, options: variant.options })
      .from(stockBalance).innerJoin(variant, eq(variant.id, stockBalance.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(and(...conds)).orderBy(product.title, variant.sku, stockBalance.locationId).limit(Math.min(o.limit ?? 500, 2000));
    return rows.map((r) => ((costScope.all || costScope.locationIds.includes(r.locationId)) ? r : { ...r, avgCostMinor: undefined }));
  }

  /** Stock card: every movement, newest first, with the running balance after it. Caller must be allowed to read this location. */
  async card(orgId: string, userId: string, variantId: string, locationId: string, limit = 200) {
    const canCost = await this.authz.can(userId, "cost:read", locationId);
    const r = await this.db.execute(sql`
      select * from (
        select m.id, m.at, m.local_date, m.kind, m.source_type, m.source_id, m.line_no, m.qty_delta, m.unit_cost_minor, m.reason, m.note, m.flags, m.actor_id,
               sum(m.qty_delta) over (order by m.id)::int as balance
        from shelfline.stock_movement m where m.org_id = ${orgId} and m.variant_id = ${variantId} and m.location_id = ${locationId}
      ) x order by id desc limit ${Math.min(limit, 1000)}`);
    const onHand = (await this.db.select({ n: stockBalance.onHand }).from(stockBalance).where(and(eq(stockBalance.variantId, variantId), eq(stockBalance.locationId, locationId))))[0]?.n ?? 0;
    return { onHand, movements: r.rows.map((x) => ({ id: Number(x.id), at: x.at, localDate: x.local_date, kind: x.kind, sourceType: x.source_type, sourceId: x.source_id, lineNo: x.line_no, qtyDelta: Number(x.qty_delta), balance: Number(x.balance), reason: x.reason, note: x.note, flags: x.flags, actorId: x.actor_id, ...(canCost ? { unitCostMinor: x.unit_cost_minor } : {}) })) };
  }

  check(orgId: string) { return this.ledger.check(orgId); }
}
