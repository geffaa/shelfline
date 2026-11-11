import { ConflictException, Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { divRound } from "@shelfline/money";
import { businessDate } from "../common/business-day";
import { DB, type Db } from "../db/db.module";
import { location, MOVEMENT_KINDS, stockBalance, stockMovement, variant } from "../db/schema";

export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface MovementInput {
  variantId: string; locationId: string; qtyDelta: number; kind: MovementKind;
  sourceType: string; sourceId: string; lineNo?: number;
  unitCostMinor?: number | null; reason?: string; note?: string; at?: Date; deviceId?: string | null;
  /** Physical facts (a sale that already happened) may drive stock negative; the movement is then flagged. Everything else is refused. */
  allowNegative?: boolean;
}
export interface AppendResult { applied: number; duplicates: number; negative: { variantId: string; locationId: string; onHand: number }[] }

const INFLOW = new Set<MovementKind>(["refund_return", "receive_po", "manual_receive", "transfer_in", "opening_balance", "online_release"]);
const OUTFLOW = new Set<MovementKind>(["sale", "transfer_out", "write_off", "online_reserve"]);
const COST_BASIS = new Set<MovementKind>(["receive_po", "manual_receive", "transfer_in", "opening_balance"]);
const NEEDS_REASON = new Set<MovementKind>(["manual_adjust", "write_off", "count_adjust"]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // byte order, independent of locale

export class InsufficientStock extends ConflictException {
  constructor(public variantId: string, public locationId: string, public onHand: number, public wanted: number) {
    super({ code: "insufficient_stock", variantId, locationId, onHand, wanted });
  }
}

/**
 * The only writer of stock. Rules:
 *  - stock changes only by appending a movement; (org, source_type, source_id, line_no, kind) is unique, so replays add nothing;
 *  - balances are projected in the same transaction, locking each (variant, location) row in sorted order (no deadlocks);
 *  - the whole batch is all-or-nothing.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(DB) private db: Db) {}

  async append(orgId: string, actorId: string | null, inputs: MovementInput[]): Promise<AppendResult> {
    return this.db.transaction((tx) => this.appendIn(tx, orgId, actorId, inputs));
  }

  /** Use inside a caller's transaction so the movement commits with the business change (sale, receipt, ...). */
  async appendIn(tx: Tx, orgId: string, actorId: string | null, inputs: MovementInput[]): Promise<AppendResult> {
    for (const m of inputs) this.validate(m);
    const variantIds = [...new Set(inputs.map((m) => m.variantId))];
    const locIds = [...new Set(inputs.map((m) => m.locationId))];
    const vs = await tx.select({ id: variant.id, trackStock: variant.trackStock }).from(variant).where(and(eq(variant.orgId, orgId), inArray(variant.id, variantIds)));
    if (vs.length !== variantIds.length) throw new NotFoundException({ code: "variant_not_found" });
    const untracked = vs.find((v) => !v.trackStock);
    if (untracked) throw new ConflictException({ code: "stock_not_tracked", variantId: untracked.id });
    const locs = await tx.select().from(location).where(and(eq(location.orgId, orgId), inArray(location.id, locIds)));
    if (locs.length !== locIds.length) throw new NotFoundException({ code: "location_not_found" });
    const locById = new Map(locs.map((l) => [l.id, l]));

    // Deterministic lock order for every caller: (variant, location), then input order for repeated keys.
    const ordered = inputs.map((m, i) => ({ m, i })).sort((a, b) => cmp(a.m.variantId, b.m.variantId) || cmp(a.m.locationId, b.m.locationId) || a.i - b.i);
    const res: AppendResult = { applied: 0, duplicates: 0, negative: [] };
    for (const { m } of ordered) {
      const loc = locById.get(m.locationId)!;
      await tx.insert(stockBalance).values({ orgId, variantId: m.variantId, locationId: m.locationId }).onConflictDoNothing();
      const [bal] = await tx.select().from(stockBalance).where(and(eq(stockBalance.variantId, m.variantId), eq(stockBalance.locationId, m.locationId))).for("update");
      // Replays are answered before any stock rule: an event already in the ledger is never re-judged against today's stock.
      const [seen] = await tx.select({ id: stockMovement.id }).from(stockMovement).where(and(eq(stockMovement.orgId, orgId), eq(stockMovement.sourceType, m.sourceType), eq(stockMovement.sourceId, m.sourceId), eq(stockMovement.lineNo, m.lineNo ?? 0), eq(stockMovement.kind, m.kind)));
      if (seen) { res.duplicates += 1; continue; }
      const at = m.at ?? new Date();
      const next = bal!.onHand + m.qtyDelta;
      // Only an outflow can create or deepen a shortfall. Inflows are always accepted, even while on_hand is still negative.
      const negative = m.qtyDelta < 0 && next < 0;
      if (negative && !m.allowNegative) throw new InsufficientStock(m.variantId, m.locationId, bal!.onHand, -m.qtyDelta);

      // Outflows snapshot the current average cost (for gross margin); inflows with a cost move the average.
      let unitCost = m.unitCostMinor ?? null; let avg = bal!.avgCostMinor;
      if (m.qtyDelta < 0 && unitCost === null) unitCost = avg;
      if (COST_BASIS.has(m.kind) && unitCost !== null) {
        avg = bal!.onHand <= 0 || avg === null ? unitCost
          : Number(divRound(BigInt(bal!.onHand) * BigInt(avg) + BigInt(m.qtyDelta) * BigInt(unitCost), BigInt(bal!.onHand + m.qtyDelta)));
      }
      const inserted = await tx.insert(stockMovement).values({
        orgId, variantId: m.variantId, locationId: m.locationId, qtyDelta: m.qtyDelta, kind: m.kind, sourceType: m.sourceType, sourceId: m.sourceId, lineNo: m.lineNo ?? 0,
        unitCostMinor: unitCost, reason: m.reason, note: m.note, at, localDate: businessDate(at, loc.timezone, loc.dayCutoff), deviceId: m.deviceId ?? null, actorId,
        flags: negative ? ["negative_stock"] : [],
      }).onConflictDoNothing().returning({ id: stockMovement.id });
      if (inserted.length === 0) { res.duplicates += 1; continue; }
      await tx.update(stockBalance).set({ onHand: next, avgCostMinor: avg, version: sql`${stockBalance.version} + 1` }).where(and(eq(stockBalance.variantId, m.variantId), eq(stockBalance.locationId, m.locationId)));
      res.applied += 1;
      if (negative) res.negative.push({ variantId: m.variantId, locationId: m.locationId, onHand: next });
    }
    return res;
  }

  private validate(m: MovementInput) {
    if (!Number.isSafeInteger(m.qtyDelta) || m.qtyDelta === 0) throw new BadRequestException({ code: "bad_quantity" });
    if (INFLOW.has(m.kind) && m.qtyDelta < 0) throw new BadRequestException({ code: "kind_requires_positive", kind: m.kind });
    if (OUTFLOW.has(m.kind) && m.qtyDelta > 0) throw new BadRequestException({ code: "kind_requires_negative", kind: m.kind });
    if (NEEDS_REASON.has(m.kind) && !m.reason) throw new BadRequestException({ code: "reason_required", kind: m.kind });
    if (m.unitCostMinor != null && (!Number.isSafeInteger(m.unitCostMinor) || m.unitCostMinor < 0)) throw new BadRequestException({ code: "bad_cost" });
    if (m.allowNegative && m.kind !== "sale" && m.kind !== "refund_return") throw new BadRequestException({ code: "negative_not_allowed_for_kind", kind: m.kind });
  }

  /** Invariant: stock_balance.on_hand must equal the sum of the ledger. Returns every pair that does not. */
  async check(orgId: string) {
    const r = await this.db.execute(sql`
      select b.variant_id, b.location_id, b.on_hand, coalesce(m.s, 0)::int as ledger_sum
      from shelfline.stock_balance b
      left join (select variant_id, location_id, sum(qty_delta) as s from shelfline.stock_movement where org_id = ${orgId} group by 1, 2) m
        on m.variant_id = b.variant_id and m.location_id = b.location_id
      where b.org_id = ${orgId} and b.on_hand <> coalesce(m.s, 0)
      union all
      select m.variant_id, m.location_id, 0, sum(m.qty_delta)::int
      from shelfline.stock_movement m
      where m.org_id = ${orgId} and not exists (select 1 from shelfline.stock_balance b where b.variant_id = m.variant_id and b.location_id = m.location_id)
      group by m.variant_id, m.location_id having sum(m.qty_delta) <> 0`);
    return r.rows.map((x) => ({ variantId: String(x.variant_id), locationId: String(x.location_id), onHand: Number(x.on_hand), ledgerSum: Number(x.ledger_sum) }));
  }
}
