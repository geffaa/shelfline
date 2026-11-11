import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { location, product, stockBalance, stockCount, stockCountLine, variant } from "../db/schema";
import { LedgerService } from "../inventory/ledger.service";

const pad = (n: number) => `SC-${String(n).padStart(6, "0")}`;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * A count freezes what the system expected at one moment (expected_at_snapshot, and a ledger watermark). People count, and on commit the
 * adjustment is counted - expected_at_snapshot, ADDED to whatever the stock is by then. Sales and receipts since the snapshot are never overwritten.
 * A blind count hides the expected figures from the counter until the count is submitted for review.
 */
@Injectable()
export class CountsService {
  constructor(@Inject(DB) private db: Db, @Inject(LedgerService) private ledger: LedgerService, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}
  private async need(actorId: string, locationId: string) { if (!(await this.authz.can(actorId, "inventory:write", locationId))) throw new ForbiddenException({ code: "forbidden", permission: "inventory:write", locationId }); }
  private async head(orgId: string, id: string, tx: Pick<Db, "select"> = this.db) { const [c] = await tx.select().from(stockCount).where(and(eq(stockCount.id, id), eq(stockCount.orgId, orgId))); if (!c) throw new NotFoundException({ code: "count_not_found" }); return c; }

  async create(orgId: string, actorId: string, v: { locationId: string; mode: "full" | "cycle"; blind: boolean; categoryId?: string; variantIds?: string[]; note?: string }, ip: string | null) {
    await this.need(actorId, v.locationId);
    const [loc] = await this.db.select().from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!loc) throw new NotFoundException({ code: "location_not_found" });
    if (!["store", "warehouse"].includes(loc.type) || loc.status !== "active") throw new BadRequestException({ code: "location_cannot_hold_stock" });
    if (v.mode === "cycle" && !v.categoryId && !(v.variantIds?.length)) throw new BadRequestException({ code: "cycle_needs_scope" });
    return this.db.transaction(async (tx) => {
      // one consistent view for the figures and the watermark: nothing can commit between the two reads
      const [wm] = (await tx.execute(sql`select coalesce(max(id), 0)::bigint as m from shelfline.stock_movement`)).rows as any[];
      let rows: { variantId: string; onHand: number }[];
      if (v.mode === "full") rows = await tx.select({ variantId: stockBalance.variantId, onHand: stockBalance.onHand }).from(stockBalance).where(and(eq(stockBalance.orgId, orgId), eq(stockBalance.locationId, v.locationId)));
      else {
        const vs = await tx.select({ id: variant.id }).from(variant).innerJoin(product, eq(product.id, variant.productId)).where(and(eq(variant.orgId, orgId), eq(variant.trackStock, true), v.categoryId ? eq(product.categoryId, v.categoryId) : inArray(variant.id, v.variantIds!)));
        const bal = vs.length ? await tx.select().from(stockBalance).where(and(eq(stockBalance.locationId, v.locationId), inArray(stockBalance.variantId, vs.map((x) => x.id)))) : [];
        const b = new Map(bal.map((x) => [x.variantId, x.onHand])); rows = vs.map((x) => ({ variantId: x.id, onHand: b.get(x.id) ?? 0 }));
      }
      if (rows.length === 0) throw new BadRequestException({ code: "nothing_to_count" });
      const n = Number((await tx.execute(sql`select nextval('shelfline.count_number_seq') as n`)).rows[0]!.n);
      const [c] = await tx.insert(stockCount).values({ orgId, locationId: v.locationId, number: pad(n), mode: v.mode, blind: v.blind, note: v.note, categoryId: v.categoryId ?? null, snapshotMovementId: Number(wm.m), createdBy: actorId }).returning();
      for (let i = 0; i < rows.length; i += 500) await tx.insert(stockCountLine).values(rows.slice(i, i + 500).map((r) => ({ countId: c!.id, variantId: r.variantId, expectedAtSnapshot: r.onHand })));
      await this.audit.record({ orgId, actorId, action: "count.create", subjectType: "stock_count", subjectId: c!.id, after: { number: c!.number, mode: v.mode, blind: v.blind, lines: rows.length, locationId: v.locationId }, ip }, tx);
      return c!;
    }, { isolationLevel: "repeatable read" });
  }

  /** Absolute counts per variant (idempotent: sending the same figure twice changes nothing). A variant outside the snapshot is added as unexpected. */
  async setCounts(orgId: string, actorId: string, id: string, lines: { variantId: string; countedQty: number }[], ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.locationId);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).for("update");
      if (c!.status !== "counting") throw new ConflictException({ code: "count_not_open", status: c!.status });
      const ids = [...new Set(lines.map((l) => l.variantId))]; const have = await tx.select().from(stockCountLine).where(and(eq(stockCountLine.countId, id), inArray(stockCountLine.variantId, ids))); const known = new Set(have.map((h) => h.variantId));
      const fresh = ids.filter((x) => !known.has(x));
      if (fresh.length) {
        const vs = await tx.select({ id: variant.id, t: variant.trackStock }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, fresh))); if (vs.length !== fresh.length) throw new NotFoundException({ code: "variant_not_found" }); if (vs.some((x) => !x.t)) throw new BadRequestException({ code: "stock_not_tracked" });
        const bal = await tx.select().from(stockBalance).where(and(eq(stockBalance.locationId, c!.locationId), inArray(stockBalance.variantId, fresh)));
        const moved = await tx.execute(sql`select variant_id, coalesce(sum(qty_delta), 0)::int as d from shelfline.stock_movement where location_id = ${c!.locationId} and id > ${c!.snapshotMovementId} and variant_id in (${sql.join(fresh.map((f) => sql`${f}::uuid`), sql`, `)}) group by 1`);
        const mv = new Map(moved.rows.map((r: any) => [r.variant_id, Number(r.d)])); const b = new Map(bal.map((x) => [x.variantId, x.onHand]));
        await tx.insert(stockCountLine).values(fresh.map((f) => ({ countId: id, variantId: f, expectedAtSnapshot: (b.get(f) ?? 0) - (mv.get(f) ?? 0), unexpected: true })));   // what the system had at the snapshot
      }
      for (const l of lines) await tx.update(stockCountLine).set({ countedQty: l.countedQty, countedBy: actorId, countedAt: new Date() }).where(and(eq(stockCountLine.countId, id), eq(stockCountLine.variantId, l.variantId)));
      return { saved: lines.length, added: fresh.length };
    });
  }
  async submit(orgId: string, actorId: string, id: string, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.locationId);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).for("update"); if (c!.status !== "counting") throw new ConflictException({ code: "count_not_open", status: c!.status });
      await tx.update(stockCount).set({ status: "review", submittedAt: new Date() }).where(eq(stockCount.id, id));
      await this.audit.record({ orgId, actorId, action: "count.submit", subjectType: "stock_count", subjectId: id, ip }, tx); return { status: "review" };
    });
  }
  async reopen(orgId: string, actorId: string, id: string, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.locationId);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).for("update"); if (c!.status !== "review") throw new ConflictException({ code: "count_not_in_review", status: c!.status });
      await tx.update(stockCount).set({ status: "counting", submittedAt: null }).where(eq(stockCount.id, id));
      await this.audit.record({ orgId, actorId, action: "count.reopen", subjectType: "stock_count", subjectId: id, ip }, tx); return { status: "counting" };
    });
  }
  async cancel(orgId: string, actorId: string, id: string, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.locationId);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).for("update"); if (!["counting", "review"].includes(c!.status)) throw new ConflictException({ code: "count_closed", status: c!.status });
      await tx.update(stockCount).set({ status: "cancelled" }).where(eq(stockCount.id, id));
      await this.audit.record({ orgId, actorId, action: "count.cancel", subjectType: "stock_count", subjectId: id, ip }, tx); return { status: "cancelled" };
    });
  }

  /** adjustment = counted - expected_at_snapshot, appended to the ledger now. `uncounted` says what to do with lines nobody counted. */
  async commit(orgId: string, actorId: string, id: string, v: { uncounted?: "skip" | "zero" }, ip: string | null) {
    const head = await this.head(orgId, id); await this.need(actorId, head.locationId);
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).for("update"); if (c!.status !== "review") throw new ConflictException({ code: "count_not_in_review", status: c!.status });
      const lines = await tx.select().from(stockCountLine).where(eq(stockCountLine.countId, id)).orderBy(asc(stockCountLine.variantId));
      const open = lines.filter((l) => l.countedQty === null); if (open.length && !v.uncounted) throw new ConflictException({ code: "uncounted_lines", uncounted: open.length });
      const adj = lines.map((l, i) => ({ l, i, counted: l.countedQty ?? (v.uncounted === "zero" ? 0 : null) })).filter((x) => x.counted !== null).map((x) => ({ ...x, delta: x.counted! - x.l.expectedAtSnapshot })).filter((x) => x.delta !== 0);
      const r = adj.length ? await this.ledger.appendIn(tx, orgId, actorId, adj.map((x) => ({ variantId: x.l.variantId, locationId: c!.locationId, qtyDelta: x.delta, kind: "count_adjust" as const, sourceType: "stock_count", sourceId: id, lineNo: x.i, reason: "stock_count", note: c!.number }))) : { applied: 0 };
      await tx.update(stockCount).set({ status: "committed", committedAt: new Date(), committedBy: actorId }).where(eq(stockCount.id, id));
      await this.audit.record({ orgId, actorId, action: "count.commit", subjectType: "stock_count", subjectId: id, after: { number: c!.number, adjusted: adj.length, netUnits: adj.reduce((a, x) => a + x.delta, 0), uncounted: open.length, uncountedAs: v.uncounted ?? null }, ip }, tx);
      return { status: "committed", adjusted: adj.length, netUnits: adj.reduce((a, x) => a + x.delta, 0), applied: r.applied };
    });
  }

  async list(orgId: string, userId: string, o: { locationId?: string; status?: string }) {
    const sc = await this.authz.scope(userId, "inventory:read"); if (!sc.all && !sc.locationIds.length) return [];
    const conds = [sql`c.org_id = ${orgId}`]; if (o.locationId) conds.push(sql`c.location_id = ${o.locationId}`); if (o.status) conds.push(sql`c.status = ${o.status}`);
    if (!sc.all) conds.push(sql`c.location_id in (${sql.join(sc.locationIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    const r = await this.db.execute(sql`select c.id, c.number, c.mode, c.blind, c.status, c.created_at, c.snapshot_at, c.location_id, l.name as location, count(sl.id)::int as lines, count(sl.counted_qty)::int as counted
      from shelfline.stock_count c join shelfline.location l on l.id = c.location_id left join shelfline.stock_count_line sl on sl.count_id = c.id where ${sql.join(conds, sql` and `)} group by c.id, l.id order by c.created_at desc limit 200`);
    return r.rows.map((x: any) => ({ id: x.id, number: x.number, mode: x.mode, blind: x.blind, status: x.status, createdAt: x.created_at, snapshotAt: x.snapshot_at, locationId: x.location_id, location: x.location, lines: x.lines, counted: x.counted }));
  }
  /** While a blind count is still being counted the expected figures and variances are not sent at all. */
  async get(orgId: string, userId: string, id: string) {
    const c = await this.head(orgId, id); if (!(await this.authz.can(userId, "inventory:read", c.locationId))) throw new ForbiddenException({ code: "forbidden", permission: "inventory:read" });
    const [loc] = await this.db.select().from(location).where(eq(location.id, c.locationId)); const hide = c.blind && c.status === "counting";
    const lines = await this.db.select({ id: stockCountLine.id, variantId: stockCountLine.variantId, expected: stockCountLine.expectedAtSnapshot, counted: stockCountLine.countedQty, unexpected: stockCountLine.unexpected, sku: variant.sku, options: variant.options, title: product.title })
      .from(stockCountLine).innerJoin(variant, eq(variant.id, stockCountLine.variantId)).innerJoin(product, eq(product.id, variant.productId)).where(eq(stockCountLine.countId, id)).orderBy(asc(product.title), asc(variant.sku));
    const moved = hide ? [] : (await this.db.execute(sql`select variant_id, sum(qty_delta)::int as d from shelfline.stock_movement where location_id = ${c.locationId} and id > ${c.snapshotMovementId} and kind <> 'count_adjust' and variant_id in (select variant_id from shelfline.stock_count_line where count_id = ${id}) group by 1`)).rows as any[];
    const mv = new Map(moved.map((r) => [r.variant_id, Number(r.d)]));
    const { snapshotMovementId: _wm, ...pub } = c; void _wm;
    return { ...pub, location: loc!.name, hidden: hide, ...(hide ? {} : { movedSinceTotal: [...mv.values()].reduce((a, b) => a + b, 0) }),
      lines: lines.map((l) => hide ? { id: l.id, variantId: l.variantId, counted: l.counted, unexpected: l.unexpected, sku: l.sku, options: l.options, title: l.title }
        : { ...l, movedSince: mv.get(l.variantId) ?? 0, variance: l.counted === null ? null : l.counted - l.expected }) };
  }
}
