import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { location, product, stockMovement, transfer, transferLine, transferReceipt, transferReceiptLine, variant } from "../db/schema";
import { LedgerService } from "../inventory/ledger.service";

const STOCKED = new Set(["store", "warehouse"]);
const pad = (n: number) => `TR-${String(n).padStart(6, "0")}`;
export const STUCK_AFTER_DAYS = 7;
export interface TransferLineIn { variantId: string; qty: number }

/**
 * Stock moves between locations in two legs through a transit location that belongs to the transfer:
 *   send:     source -qty (transfer_out)   transit +qty (transfer_in)
 *   receive:  transit -qty (transfer_out)  destination +qty (transfer_in)
 *   shortage: transit -qty (transfer_variance), when the receiver closes the transfer short.
 * Across all locations the total changes only by recorded variances, and transit returns to zero when a transfer is closed.
 */
@Injectable()
export class TransfersService {
  constructor(@Inject(DB) private db: Db, @Inject(LedgerService) private ledger: LedgerService, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}

  private async need(actorId: string, locationId: string) {
    if (!(await this.authz.can(actorId, "inventory:write", locationId))) throw new ForbiddenException({ code: "forbidden", permission: "inventory:write", locationId });
  }
  private async place(orgId: string, id: string) {
    const [l] = await this.db.select().from(location).where(and(eq(location.id, id), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    if (!STOCKED.has(l.type) || l.status !== "active") throw new BadRequestException({ code: "location_cannot_hold_stock", locationId: id }); return l;
  }

  async create(orgId: string, actorId: string, v: { fromLocationId: string; toLocationId: string; note?: string; lines: TransferLineIn[] }, ip: string | null) {
    if (v.fromLocationId === v.toLocationId) throw new BadRequestException({ code: "same_location" });
    await this.need(actorId, v.fromLocationId); await this.place(orgId, v.fromLocationId); await this.place(orgId, v.toLocationId);
    const ids = v.lines.map((l) => l.variantId); if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: "duplicate_variant" });
    const vs = await this.db.select({ id: variant.id, t: variant.trackStock }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, ids)));
    if (vs.length !== ids.length) throw new NotFoundException({ code: "variant_not_found" }); if (vs.some((x) => !x.t)) throw new BadRequestException({ code: "stock_not_tracked" });
    return this.db.transaction(async (tx) => {
      const n = Number((await tx.execute(sql`select nextval('shelfline.transfer_number_seq') as n`)).rows[0]!.n);
      const [t] = await tx.insert(transfer).values({ orgId, number: pad(n), fromLocationId: v.fromLocationId, toLocationId: v.toLocationId, note: v.note, createdBy: actorId }).returning();
      await tx.insert(transferLine).values(v.lines.map((l, i) => ({ transferId: t!.id, lineNo: i + 1, variantId: l.variantId, qtySent: l.qty })));
      await this.audit.record({ orgId, actorId, action: "transfer.create", subjectType: "transfer", subjectId: t!.id, after: { number: t!.number, ...v }, ip }, tx); return t!;
    });
  }
  async cancel(orgId: string, actorId: string, id: string, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.fromLocationId);
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transfer).where(eq(transfer.id, id)).for("update");
      if (t!.status !== "draft") throw new ConflictException({ code: "transfer_not_draft", status: t!.status });
      await tx.update(transfer).set({ status: "cancelled", closedAt: new Date() }).where(eq(transfer.id, id));
      await this.audit.record({ orgId, actorId, action: "transfer.cancel", subjectType: "transfer", subjectId: id, ip }, tx); return { status: "cancelled" };
    });
  }
  private async head(orgId: string, id: string) { const [t] = await this.db.select().from(transfer).where(and(eq(transfer.id, id), eq(transfer.orgId, orgId))); if (!t) throw new NotFoundException({ code: "transfer_not_found" }); return t; }

  async send(orgId: string, actorId: string, id: string, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.fromLocationId);
    return this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(transfer).where(eq(transfer.id, id)).for("update");
      if (t!.status !== "draft") throw new ConflictException({ code: "transfer_not_draft", status: t!.status });
      const lines = await tx.select().from(transferLine).where(eq(transferLine.transferId, id)).orderBy(asc(transferLine.lineNo));
      const [from] = await tx.select().from(location).where(eq(location.id, t!.fromLocationId));
      const [transit] = await tx.insert(location).values({ orgId, code: t!.number, name: `In transit ${t!.number}`, type: "transit", timezone: from!.timezone, dayCutoff: from!.dayCutoff }).returning();
      // leg 1a: out of the source (insufficient stock refuses the whole send)
      await this.ledger.appendIn(tx, orgId, actorId, lines.map((l, i) => ({ variantId: l.variantId, locationId: t!.fromLocationId, qtyDelta: -l.qtySent, kind: "transfer_out" as const, sourceType: "transfer_send", sourceId: id, lineNo: i, note: t!.number })));
      const costs = await tx.select({ lineNo: stockMovement.lineNo, c: stockMovement.unitCostMinor }).from(stockMovement).where(and(eq(stockMovement.orgId, orgId), eq(stockMovement.sourceType, "transfer_send"), eq(stockMovement.sourceId, id), eq(stockMovement.kind, "transfer_out")));
      const costOf = new Map(costs.map((c) => [c.lineNo, c.c]));
      // leg 1b: into the transit location at the cost it left the source with
      await this.ledger.appendIn(tx, orgId, actorId, lines.map((l, i) => ({ variantId: l.variantId, locationId: transit!.id, qtyDelta: l.qtySent, kind: "transfer_in" as const, sourceType: "transfer_send", sourceId: id, lineNo: i, unitCostMinor: costOf.get(i) ?? null, note: t!.number })));
      for (const [i, l] of lines.entries()) await tx.update(transferLine).set({ unitCostMinor: costOf.get(i) ?? null }).where(eq(transferLine.id, l.id));
      await tx.update(transfer).set({ status: "sent", sentAt: new Date(), sentBy: actorId, transitLocationId: transit!.id }).where(eq(transfer.id, id));
      await this.audit.record({ orgId, actorId, action: "transfer.send", subjectType: "transfer", subjectId: id, after: { number: t!.number, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qtySent })) }, ip }, tx);
      return { status: "sent", transitLocationId: transit!.id };
    });
  }

  async receive(orgId: string, actorId: string, id: string, v: { idempotencyKey: string; lines: { lineId: string; qty: number }[]; closeShort: boolean; note?: string }, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.toLocationId);
    return this.db.transaction(async (tx) => {
      const [again] = await tx.select().from(transferReceipt).where(and(eq(transferReceipt.orgId, orgId), eq(transferReceipt.idempotencyKey, v.idempotencyKey)));
      if (again) { if (again.transferId !== id) throw new ConflictException({ code: "idempotency_key_reused" }); const [t0] = await tx.select().from(transfer).where(eq(transfer.id, id)); return { replayed: true, status: t0!.status }; }
      const [t] = await tx.select().from(transfer).where(eq(transfer.id, id)).for("update");
      if (!["sent", "partial"].includes(t!.status)) throw new ConflictException({ code: "transfer_not_receivable", status: t!.status });
      const lines = await tx.select().from(transferLine).where(eq(transferLine.transferId, id)).orderBy(asc(transferLine.lineNo)).for("update"); const byId = new Map(lines.map((l) => [l.id, l]));
      const ids = v.lines.map((l) => l.lineId); if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: "duplicate_line" });
      const take = new Map<string, number>(); for (const l of v.lines) { const tl = byId.get(l.lineId); if (!tl) throw new NotFoundException({ code: "transfer_line_not_found", lineId: l.lineId }); const open = tl.qtySent - tl.qtyReceived - tl.qtyVariance; if (l.qty > open) throw new ConflictException({ code: "over_receipt", lineId: l.lineId, open, wanted: l.qty }); take.set(l.lineId, l.qty); }
      const short = new Map<string, number>(); if (v.closeShort) for (const tl of lines) { const rem = tl.qtySent - tl.qtyReceived - tl.qtyVariance - (take.get(tl.id) ?? 0); if (rem > 0) short.set(tl.id, rem); }
      if (take.size === 0 || [...take.values()].every((q) => q === 0)) { if (!v.closeShort) throw new BadRequestException({ code: "nothing_received" }); }
      const [rc] = await tx.insert(transferReceipt).values({ orgId, transferId: id, idempotencyKey: v.idempotencyKey, closedShort: v.closeShort, note: v.note, receivedBy: actorId }).returning();
      const moves = lines.flatMap((tl, i) => { const q = take.get(tl.id) ?? 0, s = short.get(tl.id) ?? 0; const out: Parameters<LedgerService["appendIn"]>[3] = [];
        if (q > 0) { out.push({ variantId: tl.variantId, locationId: t!.transitLocationId!, qtyDelta: -q, kind: "transfer_out", sourceType: "transfer_receive", sourceId: rc!.id, lineNo: i, note: t!.number }); out.push({ variantId: tl.variantId, locationId: t!.toLocationId, qtyDelta: q, kind: "transfer_in", sourceType: "transfer_receive", sourceId: rc!.id, lineNo: i, unitCostMinor: tl.unitCostMinor, note: t!.number }); }
        if (s > 0) out.push({ variantId: tl.variantId, locationId: t!.transitLocationId!, qtyDelta: -s, kind: "transfer_variance", sourceType: "transfer_receive", sourceId: rc!.id, lineNo: i, reason: "transfer_shortage", note: `${t!.number} closed short` });
        return out; });
      if (moves.length) await this.ledger.appendIn(tx, orgId, actorId, moves);
      const rows = [] as { receiptId: string; transferLineId: string; qtyReceived: number; qtyVariance: number }[];
      for (const tl of lines) { const q = take.get(tl.id) ?? 0, s = short.get(tl.id) ?? 0; if (!q && !s) continue; rows.push({ receiptId: rc!.id, transferLineId: tl.id, qtyReceived: q, qtyVariance: s }); await tx.update(transferLine).set({ qtyReceived: sql`${transferLine.qtyReceived} + ${q}`, qtyVariance: sql`${transferLine.qtyVariance} + ${s}` }).where(eq(transferLine.id, tl.id)); }
      if (rows.length) await tx.insert(transferReceiptLine).values(rows);
      const after = await tx.select().from(transferLine).where(eq(transferLine.transferId, id)); const done = after.every((l) => l.qtyReceived + l.qtyVariance === l.qtySent);
      await tx.update(transfer).set({ status: done ? "received" : "partial", ...(done ? { closedAt: new Date() } : {}) }).where(eq(transfer.id, id));
      const variance = rows.reduce((a, r) => a + r.qtyVariance, 0);
      await this.audit.record({ orgId, actorId, action: "transfer.receive", subjectType: "transfer", subjectId: id, after: { number: t!.number, received: rows.map((r) => ({ lineId: r.transferLineId, qty: r.qtyReceived })), variance, status: done ? "received" : "partial" }, ip }, tx);
      return { replayed: false, status: done ? "received" : "partial", variance };
    });
  }

  async list(orgId: string, userId: string, o: { status?: string; locationId?: string; limit?: number }) {
    const sc = await this.authz.scope(userId, "inventory:read"); if (!sc.all && !sc.locationIds.length) return [];
    const conds = [sql`t.org_id = ${orgId}`]; if (o.status) conds.push(sql`t.status = ${o.status}`); if (o.locationId) conds.push(sql`(t.from_location_id = ${o.locationId} or t.to_location_id = ${o.locationId})`);
    if (!sc.all) { const ids = sql.join(sc.locationIds.map((i) => sql`${i}::uuid`), sql`, `); conds.push(sql`(t.from_location_id in (${ids}) or t.to_location_id in (${ids}))`); }
    const r = await this.db.execute(sql`select t.id, t.number, t.status, t.created_at, t.sent_at, t.note, extract(epoch from (now() - t.sent_at))::float8 as transit_secs, f.id as from_id, f.name as from_name, d.id as to_id, d.name as to_name,
        coalesce(sum(l.qty_sent), 0)::int as qty_sent, coalesce(sum(l.qty_received), 0)::int as qty_received, coalesce(sum(l.qty_variance), 0)::int as qty_variance
      from shelfline.transfer t join shelfline.location f on f.id = t.from_location_id join shelfline.location d on d.id = t.to_location_id left join shelfline.transfer_line l on l.transfer_id = t.id
      where ${sql.join(conds, sql` and `)} group by t.id, f.id, d.id order by t.created_at desc limit ${Math.min(o.limit ?? 100, 300)}`);
    // time on the road is measured by the database clock, the same one that stamped sent_at
    return r.rows.map((x: any) => ({ id: x.id, number: x.number, status: x.status, createdAt: x.created_at, sentAt: x.sent_at, fromId: x.from_id, from: x.from_name, toId: x.to_id, to: x.to_name, qtySent: x.qty_sent, qtyReceived: x.qty_received, qtyVariance: x.qty_variance,
      daysInTransit: x.sent_at && ["sent", "partial"].includes(x.status) ? Math.max(0, Math.floor(Number(x.transit_secs) / 86_400)) : null,
      stuck: !!x.sent_at && ["sent", "partial"].includes(x.status) && Number(x.transit_secs) > STUCK_AFTER_DAYS * 86_400 }));
  }
  async get(orgId: string, userId: string, id: string) {
    const t = await this.head(orgId, id);
    if (!(await this.authz.can(userId, "inventory:read", t.fromLocationId)) && !(await this.authz.can(userId, "inventory:read", t.toLocationId))) throw new ForbiddenException({ code: "forbidden", permission: "inventory:read" });
    const [f] = await this.db.select().from(location).where(eq(location.id, t.fromLocationId)); const [d] = await this.db.select().from(location).where(eq(location.id, t.toLocationId));
    const lines = await this.db.select({ id: transferLine.id, lineNo: transferLine.lineNo, variantId: transferLine.variantId, qtySent: transferLine.qtySent, qtyReceived: transferLine.qtyReceived, qtyVariance: transferLine.qtyVariance, sku: variant.sku, options: variant.options, title: product.title })
      .from(transferLine).innerJoin(variant, eq(variant.id, transferLine.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(eq(transferLine.transferId, id)).orderBy(asc(transferLine.lineNo));
    const receipts = await this.db.select().from(transferReceipt).where(eq(transferReceipt.transferId, id)).orderBy(desc(transferReceipt.receivedAt));
    const [age] = (await this.db.execute(sql`select extract(epoch from (now() - sent_at))::float8 as s from shelfline.transfer where id = ${id}`)).rows as any[];
    return { ...t, from: f!.name, to: d!.name, lines, receipts, canReceive: await this.authz.can(userId, "inventory:write", t.toLocationId), canSend: await this.authz.can(userId, "inventory:write", t.fromLocationId),
      stuck: age?.s != null && ["sent", "partial"].includes(t.status) && Number(age.s) > STUCK_AFTER_DAYS * 86_400 };
  }
}
