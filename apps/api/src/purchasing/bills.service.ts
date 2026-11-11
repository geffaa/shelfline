import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { billLine, billPayment, billReceiptMatch, poLine, product, purchaseOrder, supplier, supplierBill, variant } from "../db/schema";
import { BUCKETS, bucketOf, holdReasons, matchLine, type Bucket } from "./calc";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface BillLineIn { poLineId?: string; variantId?: string; description?: string; qty: number; unitCostMinor: number }
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

@Injectable()
export class BillsService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}

  /** Three-way match of the given bill lines (billed against received and against the order), counting what other live bills already claimed. */
  private async evaluate(tx: Tx | Db, lines: { poLineId?: string | null; qty: number; unitCostMinor: number }[], excludeBillId: string | null) {
    const ids = [...new Set(lines.map((l) => l.poLineId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map<string, ReturnType<typeof matchLine> & { receivedQty: number; orderedUnitMinor: number }>();
    const pls = await tx.select().from(poLine).where(inArray(poLine.id, ids)); const byId = new Map(pls.map((p) => [p.id, p]));
    const prior = await tx.execute(sql`select bl.po_line_id, coalesce(sum(bl.qty), 0)::int as qty from shelfline.bill_line bl join shelfline.supplier_bill b on b.id = bl.bill_id
      where bl.po_line_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and b.status <> 'void' ${excludeBillId ? sql`and b.id <> ${excludeBillId}` : sql``} group by 1`);
    const before = new Map(prior.rows.map((r: any) => [r.po_line_id, Number(r.qty)]));
    const out = new Map<string, any>(); const running = new Map<string, number>();
    lines.forEach((l, i) => {
      if (!l.poLineId) return; const pl = byId.get(l.poLineId); if (!pl) throw new NotFoundException({ code: "po_line_not_found", poLineId: l.poLineId });
      const b4 = (before.get(l.poLineId) ?? 0) + (running.get(l.poLineId) ?? 0); running.set(l.poLineId, (running.get(l.poLineId) ?? 0) + l.qty);
      out.set(String(i), { ...matchLine({ billedQty: l.qty, billedQtyBefore: b4, receivedQty: pl.qtyReceived, billedUnitMinor: l.unitCostMinor, orderedUnitMinor: pl.unitCostMinor }), receivedQty: pl.qtyReceived, orderedUnitMinor: pl.unitCostMinor });
    });
    return out;
  }

  async create(orgId: string, actorId: string, v: { supplierId: string; poId?: string | null; number: string; billDate: string; dueOn?: string; lines: BillLineIn[] }, ip: string | null) {
    const [sup] = await this.db.select().from(supplier).where(and(eq(supplier.id, v.supplierId), eq(supplier.orgId, orgId))); if (!sup) throw new NotFoundException({ code: "supplier_not_found" });
    if (v.poId) { const [po] = await this.db.select().from(purchaseOrder).where(and(eq(purchaseOrder.id, v.poId), eq(purchaseOrder.orgId, orgId))); if (!po) throw new NotFoundException({ code: "po_not_found" }); if (po.supplierId !== v.supplierId) throw new BadRequestException({ code: "po_supplier_mismatch" }); }
    const plIds = v.lines.map((l) => l.poLineId).filter((x): x is string => !!x);
    if (plIds.length) {
      const pls = await this.db.select({ id: poLine.id, poId: poLine.poId, variantId: poLine.variantId, supplierId: purchaseOrder.supplierId }).from(poLine).innerJoin(purchaseOrder, eq(purchaseOrder.id, poLine.poId)).where(and(inArray(poLine.id, plIds), eq(purchaseOrder.orgId, orgId)));
      if (pls.length !== new Set(plIds).size) throw new NotFoundException({ code: "po_line_not_found" });
      if (pls.some((p) => p.supplierId !== v.supplierId || (v.poId && p.poId !== v.poId))) throw new BadRequestException({ code: "po_line_mismatch" });
    }
    const dueOn = v.dueOn ?? addDays(v.billDate, sup.termsDays);
    if (dueOn < v.billDate) throw new BadRequestException({ code: "due_before_bill_date" });
    const total = v.lines.reduce((a, l) => a + l.qty * l.unitCostMinor, 0);
    if (total <= 0) throw new BadRequestException({ code: "bill_total_zero" });
    try {
      return await this.db.transaction(async (tx) => {
        const matches = await this.evaluate(tx, v.lines, null); const reasons = holdReasons([...matches.values()]);
        const [b] = await tx.insert(supplierBill).values({ orgId, supplierId: v.supplierId, poId: v.poId ?? null, number: v.number, billDate: v.billDate, dueOn, totalMinor: total, status: reasons.length ? "held" : "open", holdReasons: reasons, createdBy: actorId }).returning();
        const rows = await tx.insert(billLine).values(v.lines.map((l, i) => ({ billId: b!.id, lineNo: i + 1, poLineId: l.poLineId ?? null, variantId: l.variantId ?? null, description: l.description?.trim() || "Goods", qty: l.qty, unitCostMinor: l.unitCostMinor, totalMinor: l.qty * l.unitCostMinor }))).returning();
        const ms = rows.flatMap((r, i) => { const m = matches.get(String(i)); return m ? [{ billId: b!.id, billLineId: r.id, poLineId: r.poLineId!, billedQty: r.qty, billedQtyToDate: m.billedQtyToDate, receivedQty: m.receivedQty, qtyDiff: m.qtyDiff, billedUnitMinor: r.unitCostMinor, orderedUnitMinor: m.orderedUnitMinor, costDiffMinor: m.costDiffMinor, status: m.status }] : []; });
        if (ms.length) await tx.insert(billReceiptMatch).values(ms);
        await this.audit.record({ orgId, actorId, action: "bill.create", subjectType: "supplier_bill", subjectId: b!.id, after: { number: v.number, totalMinor: total, status: b!.status, holdReasons: reasons }, ip }, tx);
        return b!;
      });
    } catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "bill_number_taken" }); throw e; }
  }

  /** After goods arrive, held bills for the order are matched again; those that now agree are released. Approved bills keep the approval. */
  async rematchPo(tx: Tx, orgId: string, poId: string): Promise<string[]> {
    const held = await tx.select().from(supplierBill).where(and(eq(supplierBill.orgId, orgId), eq(supplierBill.status, "held"), sql`${supplierBill.id} in (select bl.bill_id from shelfline.bill_line bl join shelfline.po_line pl on pl.id = bl.po_line_id where pl.po_id = ${poId})`)).for("update");
    const released: string[] = [];
    for (const b of held) if (await this.rematchBill(tx, b.id)) released.push(b.id);
    return released;
  }
  private async rematchBill(tx: Tx, billId: string): Promise<boolean> {
    const lines = await tx.select().from(billLine).where(eq(billLine.billId, billId)).orderBy(asc(billLine.lineNo));
    const matches = await this.evaluate(tx, lines.map((l) => ({ poLineId: l.poLineId, qty: l.qty, unitCostMinor: l.unitCostMinor })), billId);
    await tx.delete(billReceiptMatch).where(eq(billReceiptMatch.billId, billId));
    const ms = lines.flatMap((r, i) => { const m = matches.get(String(i)); return m ? [{ billId, billLineId: r.id, poLineId: r.poLineId!, billedQty: r.qty, billedQtyToDate: m.billedQtyToDate, receivedQty: m.receivedQty, qtyDiff: m.qtyDiff, billedUnitMinor: r.unitCostMinor, orderedUnitMinor: m.orderedUnitMinor, costDiffMinor: m.costDiffMinor, status: m.status }] : []; });
    if (ms.length) await tx.insert(billReceiptMatch).values(ms);
    const reasons = holdReasons([...matches.values()]);
    await tx.update(supplierBill).set(reasons.length ? { holdReasons: reasons } : { holdReasons: [], status: "open" }).where(eq(supplierBill.id, billId));
    return reasons.length === 0;
  }
  async rematch(orgId: string, actorId: string, id: string, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(supplierBill).where(and(eq(supplierBill.id, id), eq(supplierBill.orgId, orgId))).for("update"); if (!b) throw new NotFoundException({ code: "bill_not_found" });
      if (b.status !== "held") throw new ConflictException({ code: "bill_not_held", status: b.status });
      const released = await this.rematchBill(tx, id);
      await this.audit.record({ orgId, actorId, action: "bill.rematch", subjectType: "supplier_bill", subjectId: id, after: { released }, ip }, tx);
      return { released };
    });
  }
  /** Finance accepts the differences (a credit note is coming, the price was agreed by phone). The reason is kept with the bill. */
  async approve(orgId: string, actorId: string, id: string, note: string, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(supplierBill).where(and(eq(supplierBill.id, id), eq(supplierBill.orgId, orgId))).for("update"); if (!b) throw new NotFoundException({ code: "bill_not_found" });
      if (b.status !== "held") throw new ConflictException({ code: "bill_not_held", status: b.status });
      const [u] = await tx.update(supplierBill).set({ status: "open", approvedBy: actorId, approvedNote: note, approvedAt: new Date() }).where(eq(supplierBill.id, id)).returning();
      await this.audit.record({ orgId, actorId, action: "bill.approve", subjectType: "supplier_bill", subjectId: id, before: { status: "held", holdReasons: b.holdReasons }, after: { status: "open", note }, ip }, tx); return u!;
    });
  }
  async pay(orgId: string, actorId: string, id: string, v: { amountMinor: number; paidOn: string; method: string; reference?: string; idempotencyKey: string }, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [again] = await tx.select().from(billPayment).where(and(eq(billPayment.orgId, orgId), eq(billPayment.idempotencyKey, v.idempotencyKey)));
      if (again) { if (again.billId !== id) throw new ConflictException({ code: "idempotency_key_reused" }); const [b0] = await tx.select().from(supplierBill).where(eq(supplierBill.id, id)); return { replayed: true, paymentId: again.id, status: b0!.status, paidMinor: b0!.paidMinor }; }
      const [b] = await tx.select().from(supplierBill).where(and(eq(supplierBill.id, id), eq(supplierBill.orgId, orgId))).for("update"); if (!b) throw new NotFoundException({ code: "bill_not_found" });
      if (b.status === "held") throw new ConflictException({ code: "bill_held", holdReasons: b.holdReasons });
      if (b.status === "void" || b.status === "paid") throw new ConflictException({ code: "bill_not_payable", status: b.status });
      const owed = b.totalMinor - b.paidMinor; if (v.amountMinor > owed) throw new ConflictException({ code: "overpayment", owedMinor: owed, wantedMinor: v.amountMinor });
      const [p] = await tx.insert(billPayment).values({ orgId, billId: id, amountMinor: v.amountMinor, paidOn: v.paidOn, method: v.method, reference: v.reference, idempotencyKey: v.idempotencyKey, createdBy: actorId }).returning();
      const paid = b.paidMinor + v.amountMinor; const status = paid === b.totalMinor ? "paid" : "partially_paid";
      await tx.update(supplierBill).set({ paidMinor: paid, status }).where(eq(supplierBill.id, id));
      await this.audit.record({ orgId, actorId, action: "bill.pay", subjectType: "supplier_bill", subjectId: id, after: { amountMinor: v.amountMinor, method: v.method, reference: v.reference, paidMinor: paid, status }, ip }, tx);
      return { replayed: false, paymentId: p!.id, status, paidMinor: paid };
    });
  }
  async voidBill(orgId: string, actorId: string, id: string, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [b] = await tx.select().from(supplierBill).where(and(eq(supplierBill.id, id), eq(supplierBill.orgId, orgId))).for("update"); if (!b) throw new NotFoundException({ code: "bill_not_found" });
      if (b.paidMinor > 0 || b.status === "void") throw new ConflictException({ code: "bill_not_voidable", status: b.status, paidMinor: b.paidMinor });
      await tx.update(supplierBill).set({ status: "void" }).where(eq(supplierBill.id, id));
      await this.audit.record({ orgId, actorId, action: "bill.void", subjectType: "supplier_bill", subjectId: id, before: { status: b.status }, ip }, tx); return { status: "void" };
    });
  }

  async list(orgId: string, o: { status?: string; supplierId?: string; overdue?: boolean; asOf: string; q?: string; limit?: number }) {
    const conds = [sql`b.org_id = ${orgId}`]; if (o.status) conds.push(sql`b.status = ${o.status}`); if (o.supplierId) conds.push(sql`b.supplier_id = ${o.supplierId}`);
    if (o.overdue) conds.push(sql`b.status in ('held','open','partially_paid') and b.due_on < ${o.asOf}::date`);
    if (o.q) conds.push(sql`(b.number ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"} or s.name ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"})`);
    const r = await this.db.execute(sql`select b.id, b.number, b.status, b.bill_date, b.due_on, b.total_minor, b.paid_minor, b.hold_reasons, b.po_id, po.number as po_number, s.id as supplier_id, s.name as supplier
      from shelfline.supplier_bill b join shelfline.supplier s on s.id = b.supplier_id left join shelfline.purchase_order po on po.id = b.po_id where ${sql.join(conds, sql` and `)} order by b.due_on asc, b.created_at desc limit ${Math.min(o.limit ?? 200, 500)}`);
    return r.rows.map((x: any) => ({ id: x.id, number: x.number, status: x.status, billDate: x.bill_date, dueOn: x.due_on, totalMinor: Number(x.total_minor), paidMinor: Number(x.paid_minor), holdReasons: x.hold_reasons, poId: x.po_id, poNumber: x.po_number, supplierId: x.supplier_id, supplier: x.supplier, overdue: ["held", "open", "partially_paid"].includes(x.status) && String(x.due_on) < o.asOf }));
  }
  async get(orgId: string, id: string) {
    const [b] = await this.db.select().from(supplierBill).where(and(eq(supplierBill.id, id), eq(supplierBill.orgId, orgId))); if (!b) throw new NotFoundException({ code: "bill_not_found" });
    const [sup] = await this.db.select().from(supplier).where(eq(supplier.id, b.supplierId));
    const lines = await this.db.select().from(billLine).where(eq(billLine.billId, id)).orderBy(asc(billLine.lineNo));
    const matches = await this.db.select().from(billReceiptMatch).where(eq(billReceiptMatch.billId, id));
    const payments = await this.db.select().from(billPayment).where(eq(billPayment.billId, id)).orderBy(desc(billPayment.createdAt));
    const vids = lines.map((l) => l.variantId).filter((x): x is string => !!x);
    const names = vids.length ? await this.db.select({ id: variant.id, sku: variant.sku, title: product.title }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(inArray(variant.id, vids)) : [];
    const nm = new Map(names.map((n) => [n.id, n]));
    const [po] = b.poId ? await this.db.select({ number: purchaseOrder.number }).from(purchaseOrder).where(eq(purchaseOrder.id, b.poId)) : [];
    return { ...b, supplier: sup!.name, poNumber: po?.number ?? null, lines: lines.map((l) => ({ ...l, sku: l.variantId ? nm.get(l.variantId)?.sku ?? null : null, title: l.variantId ? nm.get(l.variantId)?.title ?? null : null, match: matches.find((m) => m.billLineId === l.id) ?? null })), payments };
  }

  /** Outstanding (total - paid) of every live bill, by supplier, in days-past-due buckets as of a date. Held bills are included and also totalled apart. */
  async aging(orgId: string, asOf: string) {
    const r = await this.db.execute(sql`select b.id, b.supplier_id, s.name as supplier, b.due_on, (b.total_minor - b.paid_minor) as owed, (b.status = 'held') as held from shelfline.supplier_bill b join shelfline.supplier s on s.id = b.supplier_id
      where b.org_id = ${orgId} and b.status in ('held','open','partially_paid') and b.bill_date <= ${asOf}::date`);
    const rows = new Map<string, { supplierId: string; supplier: string; total: number; held: number } & Record<Bucket, number>>();
    const zero = () => Object.fromEntries(BUCKETS.map((k) => [k, 0])) as Record<Bucket, number>; const totals = { ...zero(), total: 0, held: 0 };
    for (const x of r.rows as any[]) {
      const row = rows.get(x.supplier_id) ?? { supplierId: x.supplier_id, supplier: x.supplier, total: 0, held: 0, ...zero() }; rows.set(x.supplier_id, row);
      const owed = Number(x.owed), k = bucketOf(String(x.due_on), asOf); row[k] += owed; row.total += owed; totals[k] += owed; totals.total += owed; if (x.held) { row.held += owed; totals.held += owed; }
    }
    return { asOf, rows: [...rows.values()].sort((a, b) => b.total - a.total || a.supplier.localeCompare(b.supplier)), totals };
  }
}
