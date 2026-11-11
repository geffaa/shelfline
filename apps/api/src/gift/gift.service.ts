import { createHash, randomInt } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DB, type Db } from "../db/db.module";
import { balanceEntry, customer, giftCard } from "../db/schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";            // no 0/O, 1/I: a code read out over the phone survives
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCode = (orgId: string, c: string) => createHash("sha256").update(`${orgId}:${normalizeCode(c)}`).digest("hex");
export const generateCode = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");
export const maskedRef = (last4: string) => `Card …${last4}`;

export async function balanceOf(tx: Pick<Db, "execute">, orgId: string, type: "gift_card" | "store_credit", accountId: string): Promise<number> {
  const r = await tx.execute(sql`select coalesce(sum(delta_minor), 0)::int as b from shelfline.balance_entry where org_id = ${orgId} and account_type = ${type} and account_id = ${accountId}`);
  return Number((r.rows[0] as { b: number }).b);
}
export async function addEntry(tx: Pick<Db, "insert">, e: { orgId: string; type: "gift_card" | "store_credit"; accountId: string; delta: number; kind: "issue" | "topup" | "redeem" | "refund_credit" | "adjust"; sourceType: string; sourceId: string; lineNo?: number; locationId?: string | null; deviceId?: string | null; actorId?: string | null; note?: string; at?: Date }) {
  const r = await tx.insert(balanceEntry).values({ orgId: e.orgId, accountType: e.type, accountId: e.accountId, deltaMinor: e.delta, kind: e.kind, sourceType: e.sourceType, sourceId: e.sourceId, lineNo: e.lineNo ?? 0, locationId: e.locationId ?? null, deviceId: e.deviceId ?? null, actorId: e.actorId ?? null, note: e.note, at: e.at ?? new Date() }).onConflictDoNothing().returning({ id: balanceEntry.id });
  return r.length > 0;
}

/**
 * Gift cards and store credit are accounts made of append-only entries; the balance is their sum and is never stored.
 * A sale that spends more than the balance is a physical fact (the customer walked out with the goods): it is accepted, the balance goes negative, and an overdraft exception is raised.
 */
@Injectable()
export class GiftService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService) {}

  async issue(orgId: string, actorId: string, v: { amountMinor: number; customerId?: string | null; expiresOn?: string | null; note?: string; code?: string }, ip: string | null) {
    if (v.customerId) { const [c] = await this.db.select({ id: customer.id }).from(customer).where(and(eq(customer.id, v.customerId), eq(customer.orgId, orgId))); if (!c) throw new NotFoundException({ code: "customer_not_found" }); }
    const code = v.code ? normalizeCode(v.code).replace(/(.{4})(?=.)/g, "$1-") : generateCode(); if (normalizeCode(code).length < 8) throw new BadRequestException({ code: "code_too_short" });
    try {
      return await this.db.transaction(async (tx) => {
        const [g] = await tx.insert(giftCard).values({ orgId, codeHash: hashCode(orgId, code), codeLast4: normalizeCode(code).slice(-4), customerId: v.customerId ?? null, expiresOn: v.expiresOn ?? null, note: v.note, issuedBy: actorId }).returning();
        await addEntry(tx, { orgId, type: "gift_card", accountId: g!.id, delta: v.amountMinor, kind: "issue", sourceType: "gift_issue", sourceId: g!.id, actorId });
        await this.audit.record({ orgId, actorId, action: "gift_card.issue", subjectType: "gift_card", subjectId: g!.id, after: { last4: g!.codeLast4, amountMinor: v.amountMinor, expiresOn: v.expiresOn ?? null, customerId: v.customerId ?? null }, ip }, tx);
        return { id: g!.id, code, last4: g!.codeLast4, balanceMinor: v.amountMinor };       // the only time the code is shown
      });
    } catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "code_in_use" }); throw e; }
  }
  async topUp(orgId: string, actorId: string, id: string, v: { amountMinor: number; idempotencyKey: string; note?: string }, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [g] = await tx.select().from(giftCard).where(and(eq(giftCard.id, id), eq(giftCard.orgId, orgId))).for("update"); if (!g) throw new NotFoundException({ code: "gift_card_not_found" });
      if (g.status !== "active") throw new ConflictException({ code: "gift_card_void" });
      const fresh = await addEntry(tx, { orgId, type: "gift_card", accountId: id, delta: v.amountMinor, kind: "topup", sourceType: "gift_topup", sourceId: v.idempotencyKey, actorId, note: v.note });
      if (fresh) await this.audit.record({ orgId, actorId, action: "gift_card.topup", subjectType: "gift_card", subjectId: id, after: { last4: g.codeLast4, amountMinor: v.amountMinor }, ip }, tx);
      return { replayed: !fresh, balanceMinor: await balanceOf(tx, orgId, "gift_card", id) };
    });
  }
  async setStatus(orgId: string, actorId: string, id: string, status: "active" | "void", ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [g] = await tx.select().from(giftCard).where(and(eq(giftCard.id, id), eq(giftCard.orgId, orgId))).for("update"); if (!g) throw new NotFoundException({ code: "gift_card_not_found" });
      await tx.update(giftCard).set({ status }).where(eq(giftCard.id, id));
      await this.audit.record({ orgId, actorId, action: status === "void" ? "gift_card.void" : "gift_card.restore", subjectType: "gift_card", subjectId: id, before: { status: g.status }, after: { status, last4: g.codeLast4 }, ip }, tx); return { status };
    });
  }
  async adjustCredit(orgId: string, actorId: string, customerId: string, v: { amountMinor: number; idempotencyKey: string; note: string }, ip: string | null) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))); if (!c) throw new NotFoundException({ code: "customer_not_found" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${customerId}, 0))`);
      if (v.amountMinor < 0 && (await balanceOf(tx, orgId, "store_credit", customerId)) + v.amountMinor < 0) throw new ConflictException({ code: "insufficient_credit" });
      const fresh = await addEntry(tx, { orgId, type: "store_credit", accountId: customerId, delta: v.amountMinor, kind: "adjust", sourceType: "credit_adjust", sourceId: v.idempotencyKey, actorId, note: v.note });
      if (fresh) await this.audit.record({ orgId, actorId, action: "store_credit.adjust", subjectType: "customer", subjectId: customerId, after: { amountMinor: v.amountMinor, note: v.note }, ip }, tx);
      return { replayed: !fresh, balanceMinor: await balanceOf(tx, orgId, "store_credit", customerId) };
    });
  }

  async list(orgId: string, o: { q?: string; status?: string }) {
    const conds = [sql`g.org_id = ${orgId}`]; if (o.status) conds.push(sql`g.status = ${o.status}`); if (o.q) conds.push(sql`(g.code_last4 ilike ${o.q.replace(/[%_\\]/g, "\\$&") + "%"} or c.name ilike ${"%" + o.q.replace(/[%_\\]/g, "\\$&") + "%"})`);
    const r = await this.db.execute(sql`select g.id, g.code_last4, g.status, g.expires_on, g.created_at, g.note, c.id as customer_id, c.name as customer,
        coalesce((select sum(e.delta_minor) from shelfline.balance_entry e where e.account_type = 'gift_card' and e.account_id = g.id), 0)::int as balance,
        coalesce((select sum(e.delta_minor) from shelfline.balance_entry e where e.account_type = 'gift_card' and e.account_id = g.id and e.delta_minor > 0), 0)::int as loaded
      from shelfline.gift_card g left join shelfline.customer c on c.id = g.customer_id where ${sql.join(conds, sql` and `)} order by g.created_at desc limit 300`);
    return r.rows.map((x: any) => ({ id: x.id, last4: x.code_last4, status: x.status, expiresOn: x.expires_on, createdAt: x.created_at, note: x.note, customerId: x.customer_id, customer: x.customer, balanceMinor: x.balance, loadedMinor: x.loaded }));
  }
  async get(orgId: string, id: string) {
    const [g] = await this.db.select().from(giftCard).where(and(eq(giftCard.id, id), eq(giftCard.orgId, orgId))); if (!g) throw new NotFoundException({ code: "gift_card_not_found" });
    const entries = await this.db.select().from(balanceEntry).where(and(eq(balanceEntry.accountType, "gift_card"), eq(balanceEntry.accountId, id))).orderBy(desc(balanceEntry.id)).limit(200);
    const { codeHash: _h, ...pub } = g; void _h; return { ...pub, balanceMinor: await balanceOf(this.db, orgId, "gift_card", id), entries };
  }
  async credit(orgId: string, customerId: string) {
    const [c] = await this.db.select({ id: customer.id, name: customer.name }).from(customer).where(and(eq(customer.id, customerId), eq(customer.orgId, orgId))); if (!c) throw new NotFoundException({ code: "customer_not_found" });
    const entries = await this.db.select().from(balanceEntry).where(and(eq(balanceEntry.accountType, "store_credit"), eq(balanceEntry.accountId, customerId))).orderBy(desc(balanceEntry.id)).limit(100);
    return { customerId, name: c.name, balanceMinor: await balanceOf(this.db, orgId, "store_credit", customerId), entries };
  }
  /** What a till may ask before taking a card: is it real, active, in date, and what is on it. Needs the network; the code is the only secret. */
  async lookup(orgId: string, code: string) {
    const [g] = await this.db.select().from(giftCard).where(and(eq(giftCard.orgId, orgId), eq(giftCard.codeHash, hashCode(orgId, code)))); if (!g) throw new NotFoundException({ code: "gift_card_not_found" });
    const today = new Date().toISOString().slice(0, 10);
    return { id: g.id, last4: g.codeLast4, status: g.status, expired: !!g.expiresOn && String(g.expiresOn) < today, expiresOn: g.expiresOn, balanceMinor: await balanceOf(this.db, orgId, "gift_card", g.id) };
  }

  /**
   * Spend gift cards and store credit for the payments of one sale, inside the sale's transaction. Never refuses: problems become flags.
   * Each account is locked while its balance is read and its entry written, so two tills spending the same card are strictly ordered.
   */
  async redeemIn(tx: Tx, c0: { orgId: string; saleId: string; locationId: string; deviceId: string; actorId: string; at: Date; customerId: string | null }, payments: { tender: string; amountMinor: number; reference?: string }[], flag: (kind: string, detail?: unknown) => void): Promise<Map<number, string>> {
    let c = c0; const refs = new Map<number, string>();
    if (c.customerId) { const [k] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.id, c.customerId), eq(customer.orgId, c.orgId))); if (!k) c = { ...c, customerId: null }; }
    for (const [i, p] of payments.entries()) {
      if (p.tender === "gift_card") {
        const [g] = p.reference ? await tx.select().from(giftCard).where(and(eq(giftCard.orgId, c.orgId), eq(giftCard.codeHash, hashCode(c.orgId, p.reference)))).for("update") : [];
        if (!g) { flag("gift_card_unknown", { payment: i, amountMinor: p.amountMinor }); continue; }
        refs.set(i, maskedRef(g.codeLast4));
        const before = await balanceOf(tx, c.orgId, "gift_card", g.id);
        await addEntry(tx, { orgId: c.orgId, type: "gift_card", accountId: g.id, delta: -p.amountMinor, kind: "redeem", sourceType: "sale", sourceId: c.saleId, lineNo: i, locationId: c.locationId, deviceId: c.deviceId, actorId: c.actorId, at: c.at });
        if (g.status !== "active") flag("gift_card_void", { payment: i, last4: g.codeLast4 });
        if (g.expiresOn && String(g.expiresOn) < c.at.toISOString().slice(0, 10)) flag("gift_card_expired", { payment: i, last4: g.codeLast4, expiresOn: g.expiresOn });
        if (before < p.amountMinor) flag("gift_card_overdraft", { payment: i, last4: g.codeLast4, balanceBeforeMinor: before, amountMinor: p.amountMinor, overdrawnMinor: p.amountMinor - Math.max(0, before) });
      } else if (p.tender === "store_credit") {
        if (!c.customerId) { flag("store_credit_no_customer", { payment: i, amountMinor: p.amountMinor }); continue; }
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${c.customerId}, 0))`);
        const before = await balanceOf(tx, c.orgId, "store_credit", c.customerId);
        await addEntry(tx, { orgId: c.orgId, type: "store_credit", accountId: c.customerId, delta: -p.amountMinor, kind: "redeem", sourceType: "sale", sourceId: c.saleId, lineNo: i, locationId: c.locationId, deviceId: c.deviceId, actorId: c.actorId, at: c.at });
        refs.set(i, "Store credit");
        if (before < p.amountMinor) flag("gift_card_overdraft", { payment: i, account: "store_credit", balanceBeforeMinor: before, amountMinor: p.amountMinor, overdrawnMinor: p.amountMinor - Math.max(0, before) });
      }
    }
    return refs;
  }
}
