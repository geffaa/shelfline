import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { customer, loyaltyEntry, loyaltyProgram } from "../db/schema";
import { addEntry, balanceOf } from "../gift/gift.service";
import type { Tx } from "../inventory/ledger.service";
import { clawbackFor, pointsFor, tierFor, type Tier } from "./rules";

type Q = Pick<Db, "select" | "execute" | "insert">;
export interface Program { enabled: boolean; pointsPerDollar: number; tiers: Tier[]; redeemPoints: number; redeemValueMinor: number; birthdayBonus: number }
export const DEFAULT_PROGRAM: Program = { enabled: false, pointsPerDollar: 1, tiers: [{ name: "Member", min: 0, multBp: 10000 }, { name: "Silver", min: 500, multBp: 12500 }, { name: "Gold", min: 1500, multBp: 15000 }], redeemPoints: 100, redeemValueMinor: 500, birthdayBonus: 0 };

/** Loyalty points are a ledger: a customer's balance is the sum of their rows. Earning and taking back happen inside the sale and refund transactions, so a sale and its points cannot disagree. */
@Injectable()
export class LoyaltyService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}
  async program(orgId: string, q: Q = this.db): Promise<Program> { const [p] = await q.select().from(loyaltyProgram).where(eq(loyaltyProgram.orgId, orgId)); return p ? { enabled: p.enabled, pointsPerDollar: p.pointsPerDollar, tiers: p.tiers as Tier[], redeemPoints: p.redeemPoints, redeemValueMinor: p.redeemValueMinor, birthdayBonus: p.birthdayBonus } : DEFAULT_PROGRAM; }
  async setProgram(orgId: string, actorId: string, v: Program, ip: string | null) {
    const tiers = [...v.tiers].sort((a, b) => a.min - b.min); if (!tiers.length || tiers[0]!.min !== 0 || new Set(tiers.map((t) => t.min)).size !== tiers.length || new Set(tiers.map((t) => t.name.toLowerCase())).size !== tiers.length) throw new BadRequestException({ code: "bad_tiers" });
    await this.db.transaction(async (tx) => { await tx.insert(loyaltyProgram).values({ orgId, ...v, tiers }).onConflictDoUpdate({ target: loyaltyProgram.orgId, set: { ...v, tiers } }); await this.audit.record({ orgId, actorId, action: "loyalty.program", subjectType: "loyalty_program", subjectId: orgId, after: { ...v, tiers }, ip }, tx); });
    return this.program(orgId);
  }
  async balance(orgId: string, customerId: string, q: Q = this.db) { return Number(((await q.execute(sql`select coalesce(sum(points), 0)::int as n from shelfline.loyalty_entry where org_id = ${orgId} and customer_id = ${customerId}`)).rows[0] as { n: number }).n); }
  async lifetime(orgId: string, customerId: string, q: Q = this.db) { return Number(((await q.execute(sql`select coalesce(sum(points), 0)::int as n from shelfline.loyalty_entry where org_id = ${orgId} and customer_id = ${customerId} and kind in ('earn','clawback','bonus')`)).rows[0] as { n: number }).n); }
  async standing(orgId: string, customerId: string, q: Q = this.db) { const p = await this.program(orgId, q); const [bal, life] = await Promise.all([this.balance(orgId, customerId, q), this.lifetime(orgId, customerId, q)]); const tier = tierFor(life, p.tiers); const next = [...p.tiers].sort((a, b) => a.min - b.min).find((t) => t.min > life); return { enabled: p.enabled, points: bal, lifetime: life, tier: tier.name, multBp: tier.multBp, nextTier: next ? { name: next.name, pointsToGo: next.min - life } : null }; }

  /** In the sale's transaction: the points for what was bought (without GST), at the customer's tier. Safe to repeat for the same sale. */
  async earnIn(tx: Tx, orgId: string, customerId: string, saleId: string, netMinor: number) {
    const p = await this.program(orgId, tx); if (!p.enabled) return 0;
    const life = await this.lifetime(orgId, customerId, tx); const t = tierFor(life, p.tiers); const pts = pointsFor(netMinor, p.pointsPerDollar, t.multBp); if (pts <= 0) return 0;
    const r = await tx.insert(loyaltyEntry).values({ orgId, customerId, kind: "earn", points: pts, sourceType: "sale", sourceId: saleId, note: `${t.name} tier` }).onConflictDoNothing().returning({ id: loyaltyEntry.id }); return r.length ? pts : 0;
  }
  /** In the refund's transaction: takes back the same share of what the sale earned. */
  async clawbackIn(tx: Tx, orgId: string, customerId: string, saleId: string, refundId: string, o: { refundNetMinor: number; saleNetMinor: number; fullyRefunded: boolean }) {
    const [e] = await tx.select({ points: loyaltyEntry.points }).from(loyaltyEntry).where(and(eq(loyaltyEntry.orgId, orgId), eq(loyaltyEntry.customerId, customerId), eq(loyaltyEntry.kind, "earn"), eq(loyaltyEntry.sourceType, "sale"), eq(loyaltyEntry.sourceId, saleId))); if (!e) return 0;
    const back = Number(((await tx.execute(sql`select coalesce(sum(-points), 0)::int as n from shelfline.loyalty_entry where org_id = ${orgId} and customer_id = ${customerId} and kind = 'clawback' and note = ${`sale:${saleId}`}`)).rows[0] as { n: number }).n);
    const claw = clawbackFor({ earned: e.points, alreadyBack: back, refundNetMinor: o.refundNetMinor, saleNetMinor: o.saleNetMinor, fullyRefunded: o.fullyRefunded }); if (claw <= 0) return 0;
    const r = await tx.insert(loyaltyEntry).values({ orgId, customerId, kind: "clawback", points: -claw, sourceType: "refund", sourceId: refundId, note: `sale:${saleId}` }).onConflictDoNothing().returning({ id: loyaltyEntry.id }); return r.length ? claw : 0;
  }
  async bonusIn(tx: Tx, orgId: string, customerId: string, points: number, sourceType: string, sourceId: string, note: string) { if (points <= 0) return false; return (await tx.insert(loyaltyEntry).values({ orgId, customerId, kind: "bonus", points, sourceType, sourceId, note }).onConflictDoNothing().returning({ id: loyaltyEntry.id })).length > 0; }

  async adjust(orgId: string, actorId: string, customerId: string, v: { points: number; reason: string; idempotencyKey: string }, ip: string | null) {
    if (!Number.isInteger(v.points) || v.points === 0 || Math.abs(v.points) > 100_000) throw new BadRequestException({ code: "bad_points" });
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))).for("update"); if (!c) throw new NotFoundException({ code: "customer_not_found" });
      const r = await tx.insert(loyaltyEntry).values({ orgId, customerId, kind: "adjust", points: v.points, sourceType: "adjust", sourceId: v.idempotencyKey, note: v.reason, actorId }).onConflictDoNothing().returning({ id: loyaltyEntry.id });
      if (r.length) await this.audit.record({ orgId, actorId, action: "loyalty.adjust", subjectType: "customer", subjectId: customerId, after: { points: v.points }, detail: { reason: v.reason }, ip }, tx);
      return { replayed: !r.length, ...(await this.standing(orgId, customerId, tx)) };
    });
  }
  /** Turns points into store credit at the program's rate: whole blocks only, never more than the balance, and the two ledgers change together. */
  async redeem(orgId: string, actorId: string, customerId: string, v: { points: number; idempotencyKey: string }, ip: string | null) {
    const p = await this.program(orgId); if (!p.enabled) throw new ConflictException({ code: "program_off" }); if (!Number.isInteger(v.points) || v.points <= 0 || v.points % p.redeemPoints !== 0) throw new BadRequestException({ code: "bad_block", blockPoints: p.redeemPoints });
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))).for("update"); if (!c) throw new NotFoundException({ code: "customer_not_found" });
      const [seen] = await tx.select({ id: loyaltyEntry.id }).from(loyaltyEntry).where(and(eq(loyaltyEntry.orgId, orgId), eq(loyaltyEntry.customerId, customerId), eq(loyaltyEntry.kind, "redeem"), eq(loyaltyEntry.sourceType, "redeem"), eq(loyaltyEntry.sourceId, v.idempotencyKey)));
      const credit = (v.points / p.redeemPoints) * p.redeemValueMinor; if (seen) return { replayed: true, creditMinor: credit, ...(await this.standing(orgId, customerId, tx)) };
      if ((await this.balance(orgId, customerId, tx)) < v.points) throw new ConflictException({ code: "not_enough_points" });
      await tx.insert(loyaltyEntry).values({ orgId, customerId, kind: "redeem", points: -v.points, sourceType: "redeem", sourceId: v.idempotencyKey, note: `${v.points} points for ${(credit / 100).toFixed(2)} credit`, actorId });
      if (credit > 0) await addEntry(tx, { orgId, type: "store_credit", accountId: customerId, delta: credit, kind: "adjust", sourceType: "loyalty_redeem", sourceId: v.idempotencyKey, actorId, note: `Loyalty: ${v.points} points` });
      await this.audit.record({ orgId, actorId, action: "loyalty.redeem", subjectType: "customer", subjectId: customerId, after: { points: v.points, creditMinor: credit }, ip }, tx);
      return { replayed: false, creditMinor: credit, storeCreditMinor: await balanceOf(tx, orgId, "store_credit", customerId), ...(await this.standing(orgId, customerId, tx)) };
    });
  }
  async customerView(orgId: string, customerId: string) {
    const [c] = await this.db.select({ id: customer.id, name: customer.name }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))); if (!c) throw new NotFoundException({ code: "customer_not_found" });
    const entries = await this.db.select().from(loyaltyEntry).where(and(eq(loyaltyEntry.orgId, orgId), eq(loyaltyEntry.customerId, customerId))).orderBy(desc(loyaltyEntry.id)).limit(100);
    return { customerId, name: c.name, ...(await this.standing(orgId, customerId)), entries: entries.map((e) => ({ id: e.id, kind: e.kind, points: e.points, note: e.note, at: e.at })) };
  }
  async top(orgId: string) {
    const p = await this.program(orgId); const rows = (await this.db.execute(sql`select c.id, c.name, coalesce(sum(e.points), 0)::int as points, coalesce(sum(e.points) filter (where e.kind in ('earn','clawback','bonus')), 0)::int as lifetime from shelfline.customer c join shelfline.loyalty_entry e on e.customer_id = c.id where c.org_id = ${orgId} group by c.id, c.name order by points desc, c.name limit 50`)).rows as { id: string; name: string; points: number; lifetime: number }[];
    return { enabled: p.enabled, members: rows.map((r) => ({ customerId: r.id, name: r.name, points: Number(r.points), tier: tierFor(Number(r.lifetime), p.tiers).name })) };
  }
}
