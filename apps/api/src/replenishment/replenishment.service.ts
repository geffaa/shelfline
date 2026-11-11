import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { location, replenishmentBatch, supplier } from "../db/schema";
import { PurchasingService } from "../purchasing/purchasing.service";
import { businessDate } from "../common/business-day";
import { rank, suggest, type Position, type Suggestion } from "./suggest";

type Row = Record<string, unknown>;
const idList = (ids: string[]) => ids.length ? sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `) : sql`'00000000-0000-0000-0000-000000000000'::uuid`;
export interface Params { locationId: string; scope: "location" | "network"; lookbackDays: number; safetyDays: number; reviewDays: number }

/** Looks at how fast each product sells, what is in hand and on order, and how long the supplier takes, and says what to order. Drafting the orders is a separate, explicit step. */
@Injectable()
export class ReplenishmentService {
  constructor(@Inject(DB) private db: Db, @Inject(PurchasingService) private purchasing: PurchasingService) {}

  async suggestions(orgId: string, p: Params, now = new Date()): Promise<{ location: string; scope: string; suggestions: (Suggestion & { supplier: string | null; leadTimeDays: number; costMinor: number })[]; withoutSupplier: number }> {
    const [loc] = await this.db.select().from(location).where(and(eq(location.id, p.locationId), eq(location.orgId, orgId))); if (!loc) throw new NotFoundException({ code: "location_not_found" });
    const places = p.scope === "network" ? (await this.db.select({ id: location.id, type: location.type }).from(location).where(eq(location.orgId, orgId))).filter((l) => l.type === "store" || l.type === "warehouse").map((l) => l.id) : [p.locationId];
    const stores = p.scope === "network" ? (await this.db.select({ id: location.id }).from(location).where(and(eq(location.orgId, orgId), eq(location.type, "store")))).map((l) => l.id) : [p.locationId];
    const since = new Date(Date.parse(businessDate(now, loc.timezone, loc.dayCutoff) + "T12:00:00Z") - p.lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const sold = new Map(((await this.db.execute(sql`select sl.variant_id::text as v, sum(sl.qty - sl.refunded_qty)::int as n from shelfline.sale_line sl join shelfline.sale s on s.id = sl.sale_id where s.org_id = ${orgId} and s.location_id in (${idList(stores)}) and s.local_date >= ${since}::date and s.status in ('completed','partially_refunded','refunded') group by 1`)).rows as Row[]).map((r) => [String(r.v), Number(r.n)]));
    const ids = [...sold.keys()].filter((v) => (sold.get(v) ?? 0) > 0); if (!ids.length) return { location: loc.name, scope: p.scope, suggestions: [], withoutSupplier: 0 };
    const V = sql`${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}`;
    const info = (await this.db.execute(sql`select v.id::text as id, v.sku, p.title, v.cost_minor from shelfline.variant v join shelfline.product p on p.id = v.product_id where v.id in (${V}) and v.status = 'active' and v.track_stock`)).rows as Row[];
    const stock = new Map(((await this.db.execute(sql`select variant_id::text as v, sum(on_hand)::int as n, max(avg_cost_minor)::int as cost from shelfline.stock_balance where variant_id in (${V}) and location_id in (${idList(places)}) group by 1`)).rows as Row[]).map((r) => [String(r.v), r]));
    const inc = new Map(((await this.db.execute(sql`select pl.variant_id::text as v, sum(pl.qty_ordered - pl.qty_received)::int as n from shelfline.po_line pl join shelfline.purchase_order po on po.id = pl.po_id where po.org_id = ${orgId} and po.status in ('sent','partial') and ${p.scope === "network" ? sql`true` : sql`po.location_id = ${p.locationId}::uuid`} and pl.variant_id in (${V}) group by 1`)).rows as Row[]).map((r) => [String(r.v), Number(r.n)]));
    const last = new Map(((await this.db.execute(sql`select distinct on (pl.variant_id) pl.variant_id::text as v, po.supplier_id::text as s, pl.unit_cost_minor as cost from shelfline.po_line pl join shelfline.purchase_order po on po.id = pl.po_id where po.org_id = ${orgId} and pl.variant_id in (${V}) and po.status <> 'cancelled' order by pl.variant_id, po.created_at desc`)).rows as Row[]).map((r) => [String(r.v), r]));
    const sups = new Map((await this.db.select().from(supplier).where(and(eq(supplier.orgId, orgId), eq(supplier.status, "active")))).map((s) => [s.id, s]));
    const out: (Suggestion & { supplier: string | null; leadTimeDays: number; costMinor: number })[] = []; let noSup = 0;
    for (const r of info) {
      const v = String(r.id); const l = last.get(v); const sid = l && sups.has(String(l.s)) ? String(l.s) : null; const sup = sid ? sups.get(sid)! : null; const st = stock.get(v);
      const cost = Number(l?.cost ?? st?.cost ?? r.cost_minor ?? 0);
      const pos: Position = { variantId: v, sku: String(r.sku), title: String(r.title), onHand: Number(st?.n ?? 0), incoming: inc.get(v) ?? 0, soldUnits: sold.get(v) ?? 0, lookbackDays: p.lookbackDays, leadTimeDays: sup?.leadTimeDays ?? 7, supplierId: sid, unitCostMinor: cost };
      const s = suggest(pos, { safetyDays: p.safetyDays, reviewDays: p.reviewDays }); if (!s) continue; if (!sid) noSup++;
      out.push({ ...s, supplier: sup?.name ?? null, leadTimeDays: pos.leadTimeDays, costMinor: s.qty * s.unitCostMinor });
    }
    return { location: loc.name, scope: p.scope, suggestions: rank(out).map((x) => x as never), withoutSupplier: noSup };
  }

  /** One draft order per supplier, delivering to the chosen place. Drafts only: nothing is sent to a supplier. Pressing the button twice with the same key gives the same drafts. */
  async draft(orgId: string, actorId: string, v: { locationId: string; key: string; lines: { variantId: string; supplierId: string; qty: number; unitCostMinor: number }[] }, ip: string | null) {
    const [seen] = await this.db.select().from(replenishmentBatch).where(and(eq(replenishmentBatch.orgId, orgId), eq(replenishmentBatch.key, v.key))); if (seen) return { replayed: true, poIds: seen.poIds };
    if (!v.lines.length) throw new BadRequestException({ code: "nothing_to_order" });
    const by = new Map<string, typeof v.lines>(); for (const l of v.lines) (by.get(l.supplierId) ?? by.set(l.supplierId, []).get(l.supplierId)!).push(l);
    const ids = [...by.keys()]; const ok = await this.db.select({ id: supplier.id }).from(supplier).where(and(eq(supplier.orgId, orgId), inArray(supplier.id, ids), eq(supplier.status, "active"))); if (ok.length !== ids.length) throw new NotFoundException({ code: "supplier_not_found" });
    const poIds: string[] = [];
    for (const [supplierId, lines] of by) {
      const merged = new Map<string, { variantId: string; qty: number; unitCostMinor: number }>(); for (const l of lines) { const e = merged.get(l.variantId); if (e) e.qty += l.qty; else merged.set(l.variantId, { variantId: l.variantId, qty: l.qty, unitCostMinor: l.unitCostMinor }); }
      const po = await this.purchasing.createPo(orgId, actorId, { supplierId, locationId: v.locationId, note: "Drafted from reorder suggestions", lines: [...merged.values()] }, ip); poIds.push((po as { id: string }).id);
    }
    try { await this.db.insert(replenishmentBatch).values({ orgId, key: v.key, locationId: v.locationId, poIds, createdBy: actorId }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "already_drafting" }); throw e; }
    return { replayed: false, poIds };
  }
}
