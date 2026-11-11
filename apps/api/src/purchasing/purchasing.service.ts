import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { location, poLine, product, purchaseOrder, receipt, receiptLine, supplier, supplierBill, variant } from "../db/schema";
import { LedgerService } from "../inventory/ledger.service";
import { landedCosts } from "./calc";
import { BillsService } from "./bills.service";

const STOCKED = new Set(["store", "warehouse"]);
const pad = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, "0")}`;
export interface PoLineIn { variantId: string; qty: number; unitCostMinor: number }

@Injectable()
export class PurchasingService {
  constructor(@Inject(DB) private db: Db, @Inject(LedgerService) private ledger: LedgerService, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService, @Inject(BillsService) private bills: BillsService) {}

  // ------------------------------------------------------------ suppliers
  async listSuppliers(orgId: string, o: { q?: string; status?: string }) {
    const conds = [eq(supplier.orgId, orgId)]; if (o.status) conds.push(eq(supplier.status, o.status));
    if (o.q) conds.push(sql`${supplier.name} ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"}`);
    const rows = await this.db.select().from(supplier).where(and(...conds)).orderBy(asc(sql`lower(${supplier.name})`));
    const open = await this.db.execute(sql`select supplier_id, count(*)::int as bills, coalesce(sum(total_minor - paid_minor), 0)::bigint as owed from shelfline.supplier_bill where org_id = ${orgId} and status in ('held','open','partially_paid') group by 1`);
    const po = await this.db.execute(sql`select supplier_id, count(*)::int as n from shelfline.purchase_order where org_id = ${orgId} and status in ('sent','partial') group by 1`);
    const o1 = new Map(open.rows.map((r: any) => [r.supplier_id, r])), o2 = new Map(po.rows.map((r: any) => [r.supplier_id, r]));
    return rows.map((s) => ({ ...s, openBills: Number((o1.get(s.id) as any)?.bills ?? 0), owedMinor: Number((o1.get(s.id) as any)?.owed ?? 0), openOrders: Number((o2.get(s.id) as any)?.n ?? 0) }));
  }
  async createSupplier(orgId: string, actorId: string, v: { name: string; contactName?: string; email?: string; phone?: string; termsDays?: number; leadTimeDays?: number; note?: string }, ip: string | null) {
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.insert(supplier).values({ orgId, ...v }).returning();
        await this.audit.record({ orgId, actorId, action: "supplier.create", subjectType: "supplier", subjectId: s!.id, after: v, ip }, tx); return s!;
      });
    } catch (e: any) { if (e?.cause?.code === "23505" || e?.code === "23505") throw new ConflictException({ code: "supplier_name_taken" }); throw e; }
  }
  async updateSupplier(orgId: string, actorId: string, id: string, v: Partial<{ name: string; contactName: string | null; email: string | null; phone: string | null; termsDays: number; leadTimeDays: number; status: "active" | "archived"; note: string | null }>, ip: string | null) {
    const [before] = await this.db.select().from(supplier).where(and(eq(supplier.id, id), eq(supplier.orgId, orgId))); if (!before) throw new NotFoundException({ code: "supplier_not_found" });
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.update(supplier).set(v).where(eq(supplier.id, id)).returning();
        await this.audit.record({ orgId, actorId, action: "supplier.update", subjectType: "supplier", subjectId: id, before, after: v, ip }, tx); return s!;
      });
    } catch (e: any) { if (e?.cause?.code === "23505" || e?.code === "23505") throw new ConflictException({ code: "supplier_name_taken" }); throw e; }
  }

  // ------------------------------------------------------------ purchase orders
  private async checkPlace(orgId: string, supplierId: string, locationId: string, lines: PoLineIn[]) {
    const [s] = await this.db.select().from(supplier).where(and(eq(supplier.id, supplierId), eq(supplier.orgId, orgId))); if (!s) throw new NotFoundException({ code: "supplier_not_found" });
    if (s.status !== "active") throw new BadRequestException({ code: "supplier_archived" });
    const [l] = await this.db.select().from(location).where(and(eq(location.id, locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    if (!STOCKED.has(l.type) || l.status !== "active") throw new BadRequestException({ code: "location_cannot_hold_stock" });
    const ids = lines.map((x) => x.variantId); if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: "duplicate_variant" });
    const vs = await this.db.select({ id: variant.id, trackStock: variant.trackStock }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, ids)));
    if (vs.length !== ids.length) throw new NotFoundException({ code: "variant_not_found" });
    if (vs.some((v) => !v.trackStock)) throw new BadRequestException({ code: "stock_not_tracked" });
  }
  async createPo(orgId: string, actorId: string, v: { supplierId: string; locationId: string; expectedOn?: string | null; note?: string; lines: PoLineIn[] }, ip: string | null) {
    await this.checkPlace(orgId, v.supplierId, v.locationId, v.lines);
    return this.db.transaction(async (tx) => {
      const n = Number((await tx.execute(sql`select nextval('shelfline.po_number_seq') as n`)).rows[0]!.n);
      const [po] = await tx.insert(purchaseOrder).values({ orgId, supplierId: v.supplierId, locationId: v.locationId, number: pad("PO", n), expectedOn: v.expectedOn ?? null, note: v.note, createdBy: actorId }).returning();
      await tx.insert(poLine).values(v.lines.map((l, i) => ({ poId: po!.id, lineNo: i + 1, variantId: l.variantId, qtyOrdered: l.qty, unitCostMinor: l.unitCostMinor })));
      await this.audit.record({ orgId, actorId, action: "po.create", subjectType: "purchase_order", subjectId: po!.id, after: { number: po!.number, ...v }, ip }, tx);
      return po!;
    });
  }
  private async load(orgId: string, id: string, tx: Pick<Db, "select"> = this.db) {
    const [po] = await tx.select().from(purchaseOrder).where(and(eq(purchaseOrder.id, id), eq(purchaseOrder.orgId, orgId))); if (!po) throw new NotFoundException({ code: "po_not_found" }); return po;
  }
  async updatePo(orgId: string, actorId: string, id: string, v: { expectedOn?: string | null; note?: string | null; lines?: PoLineIn[] }, ip: string | null) {
    const po = await this.load(orgId, id); if (po.status !== "draft") throw new ConflictException({ code: "po_not_draft", status: po.status });
    if (v.lines) await this.checkPlace(orgId, po.supplierId, po.locationId, v.lines);
    return this.db.transaction(async (tx) => {
      const set: Record<string, unknown> = {}; if ("expectedOn" in v) set.expectedOn = v.expectedOn; if ("note" in v) set.note = v.note;
      if (Object.keys(set).length) await tx.update(purchaseOrder).set(set).where(eq(purchaseOrder.id, id));
      if (v.lines) { await tx.delete(poLine).where(eq(poLine.poId, id)); await tx.insert(poLine).values(v.lines.map((l, i) => ({ poId: id, lineNo: i + 1, variantId: l.variantId, qtyOrdered: l.qty, unitCostMinor: l.unitCostMinor }))); }
      await this.audit.record({ orgId, actorId, action: "po.update", subjectType: "purchase_order", subjectId: id, after: v, ip }, tx);
      return this.load(orgId, id, tx);
    });
  }
  private async move(orgId: string, actorId: string, id: string, from: string[], to: string, action: string, ip: string | null, extra: Record<string, unknown> = {}, guard?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>) {
    return this.db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrder).where(and(eq(purchaseOrder.id, id), eq(purchaseOrder.orgId, orgId))).for("update"); if (!po) throw new NotFoundException({ code: "po_not_found" });
      if (!from.includes(po.status)) throw new ConflictException({ code: "po_wrong_status", status: po.status, allowed: from });
      if (guard) await guard(tx);
      const [u] = await tx.update(purchaseOrder).set({ status: to, ...extra }).where(eq(purchaseOrder.id, id)).returning();
      await this.audit.record({ orgId, actorId, action, subjectType: "purchase_order", subjectId: id, before: { status: po.status }, after: { status: to }, ip }, tx); return u!;
    });
  }
  send(orgId: string, actorId: string, id: string, ip: string | null) { return this.move(orgId, actorId, id, ["draft"], "sent", "po.send", ip, { sentAt: new Date() }); }
  cancel(orgId: string, actorId: string, id: string, ip: string | null) {
    return this.move(orgId, actorId, id, ["draft", "sent", "partial"], "cancelled", "po.cancel", ip, { closedAt: new Date() }, async (tx) => {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(receipt).where(eq(receipt.poId, id)); if (r!.n > 0) throw new ConflictException({ code: "po_has_receipts" });
    });
  }
  /** Stops waiting for the rest of a part-delivered order. What arrived stays; the open balance is dropped. */
  close(orgId: string, actorId: string, id: string, ip: string | null) { return this.move(orgId, actorId, id, ["partial"], "closed", "po.close", ip, { closedAt: new Date() }); }

  async listPos(orgId: string, o: { status?: string; supplierId?: string; locationId?: string; q?: string; limit?: number }) {
    const conds = [sql`po.org_id = ${orgId}`]; if (o.status) conds.push(sql`po.status = ${o.status}`); if (o.supplierId) conds.push(sql`po.supplier_id = ${o.supplierId}`); if (o.locationId) conds.push(sql`po.location_id = ${o.locationId}`);
    if (o.q) conds.push(sql`(po.number ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"} or s.name ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"})`);
    const r = await this.db.execute(sql`
      select po.id, po.number, po.status, po.expected_on, po.created_at, po.sent_at, s.id as supplier_id, s.name as supplier, l.id as location_id, l.name as location,
             coalesce(sum(pl.qty_ordered), 0)::int as qty_ordered, coalesce(sum(pl.qty_received), 0)::int as qty_received, coalesce(sum(pl.qty_ordered * pl.unit_cost_minor), 0)::bigint as value_minor
      from shelfline.purchase_order po join shelfline.supplier s on s.id = po.supplier_id join shelfline.location l on l.id = po.location_id left join shelfline.po_line pl on pl.po_id = po.id
      where ${sql.join(conds, sql` and `)} group by po.id, s.id, l.id order by po.created_at desc limit ${Math.min(o.limit ?? 100, 500)}`);
    return r.rows.map((x: any) => ({ id: x.id, number: x.number, status: x.status, expectedOn: x.expected_on, createdAt: x.created_at, sentAt: x.sent_at, supplierId: x.supplier_id, supplier: x.supplier, locationId: x.location_id, location: x.location, qtyOrdered: x.qty_ordered, qtyReceived: x.qty_received, valueMinor: Number(x.value_minor) }));
  }

  async getPo(orgId: string, id: string) {
    const po = await this.load(orgId, id);
    const [sup] = await this.db.select().from(supplier).where(eq(supplier.id, po.supplierId)); const [loc] = await this.db.select().from(location).where(eq(location.id, po.locationId));
    const lines = await this.db.select({ id: poLine.id, lineNo: poLine.lineNo, variantId: poLine.variantId, qtyOrdered: poLine.qtyOrdered, qtyReceived: poLine.qtyReceived, unitCostMinor: poLine.unitCostMinor, sku: variant.sku, options: variant.options, title: product.title })
      .from(poLine).innerJoin(variant, eq(variant.id, poLine.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(eq(poLine.poId, id)).orderBy(asc(poLine.lineNo));
    const receipts = await this.db.select().from(receipt).where(eq(receipt.poId, id)).orderBy(desc(receipt.receivedAt));
    const rl = receipts.length ? await this.db.select().from(receiptLine).where(inArray(receiptLine.receiptId, receipts.map((r) => r.id))).orderBy(asc(receiptLine.lineNo)) : [];
    const bills = await this.db.select({ id: supplierBill.id, number: supplierBill.number, status: supplierBill.status, totalMinor: supplierBill.totalMinor, paidMinor: supplierBill.paidMinor, holdReasons: supplierBill.holdReasons }).from(supplierBill).where(eq(supplierBill.poId, id));
    return { ...po, supplier: sup!.name, termsDays: sup!.termsDays, location: loc!.name, lines, receipts: receipts.map((r) => ({ ...r, lines: rl.filter((x) => x.receiptId === r.id) })), bills };
  }

  async receive(orgId: string, actorId: string, id: string, v: { idempotencyKey: string; lines: { poLineId: string; qty: number }[]; freightMinor: number; otherCostMinor: number; note?: string }, ip: string | null) {
    const head = await this.load(orgId, id);
    if (!(await this.authz.can(actorId, "inventory:write", head.locationId))) throw new ForbiddenException({ code: "forbidden", permission: "inventory:write", locationId: head.locationId });
    return this.db.transaction(async (tx) => {
      const [again] = await tx.select().from(receipt).where(and(eq(receipt.orgId, orgId), eq(receipt.idempotencyKey, v.idempotencyKey)));
      if (again) { if (again.poId !== id) throw new ConflictException({ code: "idempotency_key_reused" }); return { replayed: true, receiptId: again.id, number: again.number, status: (await this.load(orgId, id, tx)).status }; }
      const [po] = await tx.select().from(purchaseOrder).where(eq(purchaseOrder.id, id)).for("update");
      if (!["sent", "partial"].includes(po!.status)) throw new ConflictException({ code: "po_not_receivable", status: po!.status });
      const lines = await tx.select().from(poLine).where(eq(poLine.poId, id)).for("update"); const byId = new Map(lines.map((l) => [l.id, l]));
      const ids = v.lines.map((l) => l.poLineId); if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: "duplicate_line" });
      for (const l of v.lines) { const pl = byId.get(l.poLineId); if (!pl) throw new NotFoundException({ code: "po_line_not_found", poLineId: l.poLineId }); if (l.qty > pl.qtyOrdered - pl.qtyReceived) throw new ConflictException({ code: "over_receipt", poLineId: l.poLineId, open: pl.qtyOrdered - pl.qtyReceived, wanted: l.qty }); }
      const landed = landedCosts(v.lines.map((l) => ({ qty: l.qty, unitCostMinor: byId.get(l.poLineId)!.unitCostMinor })), v.freightMinor + v.otherCostMinor);
      const n = Number((await tx.execute(sql`select nextval('shelfline.receipt_number_seq') as n`)).rows[0]!.n);
      const [rc] = await tx.insert(receipt).values({ orgId, poId: id, supplierId: po!.supplierId, locationId: po!.locationId, number: pad("GR", n), idempotencyKey: v.idempotencyKey, freightMinor: v.freightMinor, otherCostMinor: v.otherCostMinor, note: v.note, receivedBy: actorId }).returning();
      await tx.insert(receiptLine).values(v.lines.map((l, i) => { const pl = byId.get(l.poLineId)!; return { receiptId: rc!.id, lineNo: i + 1, poLineId: pl.id, variantId: pl.variantId, qty: l.qty, unitCostMinor: pl.unitCostMinor, landedAllocMinor: landed[i]!.allocMinor, landedUnitCostMinor: landed[i]!.landedUnitCostMinor }; }));
      for (const l of v.lines) await tx.update(poLine).set({ qtyReceived: sql`${poLine.qtyReceived} + ${l.qty}` }).where(eq(poLine.id, l.poLineId));
      await this.ledger.appendIn(tx, orgId, actorId, v.lines.map((l, i) => ({ variantId: byId.get(l.poLineId)!.variantId, locationId: po!.locationId, qtyDelta: l.qty, kind: "receive_po" as const, sourceType: "receipt", sourceId: rc!.id, lineNo: i, unitCostMinor: landed[i]!.landedUnitCostMinor, note: `${po!.number} ${rc!.number}` })));
      const after = await tx.select().from(poLine).where(eq(poLine.poId, id)); const done = after.every((l) => l.qtyReceived === l.qtyOrdered);
      await tx.update(purchaseOrder).set({ status: done ? "received" : "partial", ...(done ? { closedAt: new Date() } : {}) }).where(eq(purchaseOrder.id, id));
      const released = await this.bills.rematchPo(tx, orgId, id);
      await this.audit.record({ orgId, actorId, action: "po.receive", subjectType: "purchase_order", subjectId: id, after: { receipt: rc!.number, lines: v.lines, freightMinor: v.freightMinor, otherCostMinor: v.otherCostMinor, status: done ? "received" : "partial", billsReleased: released }, ip }, tx);
      return { replayed: false, receiptId: rc!.id, number: rc!.number, status: done ? "received" : "partial", landed: landed.map((x, i) => ({ poLineId: v.lines[i]!.poLineId, ...x })), billsReleased: released };
    });
  }
}
