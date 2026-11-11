import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { MailService } from "../access/mail.service";
import { AuditService } from "../audit/audit.service";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { campaign, customer, flow, marketingMessage, marketingSetting, org, segment } from "../db/schema";
import { logConsent } from "./consent";
import { LoyaltyService } from "./loyalty.service";
import { matchSegment, render, sendBlock, tierFor, type Facts, type Rules } from "./rules";

type Row = Record<string, unknown>;
export interface FlowConfig { subject: string; body: string; inactiveDays?: number; afterDays?: number }
export const FLOW_DEFAULTS: Record<string, { name: string; config: FlowConfig }> = {
  win_back: { name: "Win back lapsed customers", config: { inactiveDays: 90, subject: "We have missed you, {{first_name}}", body: "Hi {{first_name}},\n\nIt has been a while since your last visit. Come and see what is new: we would love to see you again.\n" } },
  birthday: { name: "Birthday message", config: { subject: "Happy birthday, {{first_name}}", body: "Happy birthday, {{first_name}}!\n\nThank you for being one of our customers. Have a great day.\n" } },
  post_purchase: { name: "Thank you after a purchase", config: { afterDays: 3, subject: "How are the new shoes, {{first_name}}?", body: "Hi {{first_name}},\n\nThank you for your recent purchase. If anything is not right, bring it back and we will sort it out.\n" } },
};
export interface Audience { matched: number; eligible: number; skipped: { no_consent: number; no_email: number; frequency: number } }

/** Segments, campaigns and flows. One rule governs every send, from either path: nobody who has not said yes is ever emailed, and nobody is emailed again before the gap is up. */
@Injectable()
export class MarketingService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null; private logger = new Logger("marketing");
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(MailService) private mail: MailService, @Inject(AuditService) private audit: AuditService, @Inject(LoyaltyService) private loyalty: LoyaltyService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.runAllFlows().catch((e) => this.logger.warn(`flows: ${String(e)}`)); }, 60 * 60_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ------------------------------------------------------------ settings and the unsubscribe link
  async settings(orgId: string) { const [s] = await this.db.select().from(marketingSetting).where(eq(marketingSetting.orgId, orgId)); return { minGapDays: s?.minGapDays ?? 7 }; }
  async setSettings(orgId: string, actorId: string, v: { minGapDays: number }, ip: string | null) { await this.db.insert(marketingSetting).values({ orgId, ...v }).onConflictDoUpdate({ target: marketingSetting.orgId, set: v }); await this.audit.record({ orgId, actorId, action: "marketing.settings", subjectType: "org", subjectId: orgId, after: v, ip }); return this.settings(orgId); }
  private sig(customerId: string) { return createHmac("sha256", this.cfg.encryptionKey).update(`unsubscribe:${customerId}`).digest("hex").slice(0, 32); }
  unsubscribeUrl(customerId: string) { return `${this.cfg.publicApiUrl}/marketing/unsubscribe?c=${customerId}&s=${this.sig(customerId)}`; }
  /** One click, no sign-in, and the same answer if clicked twice. The link carries a signature only the server can make. */
  async unsubscribe(customerId: string, sig: string) {
    const want = Buffer.from(this.sig(customerId)), got = Buffer.from(sig ?? ""); if (want.length !== got.length || !timingSafeEqual(want, got)) throw new NotFoundException({ code: "bad_link" });
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(customer).where(eq(customer.id, customerId)).for("update"); if (!c) throw new NotFoundException({ code: "bad_link" }); const [o] = await tx.select({ name: org.name }).from(org).where(eq(org.id, c.orgId));
      const before = c.marketingConsent as { email?: boolean; sms?: boolean };
      if (before.email !== false) { const after = { ...before, email: false }; await tx.update(customer).set({ marketingConsent: after as never, updatedAt: new Date() }).where(eq(customer.id, customerId)); await logConsent(tx, { orgId: c.orgId, customerId, before, after, source: "unsubscribe_link" }); }
      return { shop: o!.name };
    });
  }

  // ------------------------------------------------------------ who is who
  private async facts(orgId: string): Promise<{ id: string; name: string; email: string | null; consentEmail: boolean | undefined; facts: Facts; birthDay: number | null; lastAt: Date | null; orders: number }[]> {
    const p = await this.loyalty.program(orgId);
    const rows = (await this.db.execute(sql`
      select c.id, c.name, c.email, c.marketing_consent, c.birth_month, c.birth_day, count(s.id)::int as orders, coalesce(sum(s.total_minor), 0)::int as spent, max(s.effective_at) as last_at,
        coalesce(array_agg(distinct s.location_id::text) filter (where s.location_id is not null), '{}') as locs,
        (select coalesce(sum(e.points), 0)::int from shelfline.loyalty_entry e where e.customer_id = c.id and e.kind in ('earn','clawback','bonus')) as lifetime
      from shelfline.customer c left join shelfline.sale s on s.customer_id = c.id and s.status in ('completed','partially_refunded','refunded') where c.org_id = ${orgId} group by c.id`)).rows as Row[];
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), email: (r.email as string | null) ?? null, consentEmail: (r.marketing_consent as { email?: boolean } | null)?.email, birthDay: r.birth_day === null ? null : Number(r.birth_day), lastAt: r.last_at ? new Date(String(r.last_at)) : null, orders: Number(r.orders),
      facts: { orders: Number(r.orders), spentMinor: Number(r.spent), lastPurchaseAt: r.last_at ? new Date(String(r.last_at)) : null, locationIds: r.locs as string[], tier: tierFor(Number(r.lifetime), p.tiers).name, birthMonth: r.birth_month === null ? null : Number(r.birth_month) } }));
  }
  private async lastSent(orgId: string): Promise<Map<string, Date>> { return new Map(((await this.db.execute(sql`select customer_id::text as c, max(created_at) as at from shelfline.marketing_message where org_id = ${orgId} and status = 'sent' group by 1`)).rows as Row[]).map((r) => [String(r.c), new Date(String(r.at))])); }

  // ------------------------------------------------------------ segments
  async listSegments(orgId: string) { const all = await this.facts(orgId); const now = new Date(); return Promise.all((await this.db.select().from(segment).where(eq(segment.orgId, orgId)).orderBy(asc(segment.name))).map(async (s) => ({ id: s.id, name: s.name, rules: s.rules as Rules, members: all.filter((c) => matchSegment(s.rules as Rules, c.facts, now)).length }))); }
  async preview(orgId: string, rules: Rules, now = new Date()): Promise<Audience & { sample: string[] }> { const all = await this.facts(orgId); return { ...(await this.audienceOf(orgId, all.filter((c) => matchSegment(rules, c.facts, now)), now)), sample: all.filter((c) => matchSegment(rules, c.facts, now)).slice(0, 5).map((c) => c.name) }; }
  async createSegment(orgId: string, actorId: string, v: { name: string; rules: Rules }, ip: string | null) {
    try { return await this.db.transaction(async (tx) => { const [s] = await tx.insert(segment).values({ orgId, name: v.name.trim(), rules: v.rules as never, createdBy: actorId }).returning(); await this.audit.record({ orgId, actorId, action: "segment.create", subjectType: "segment", subjectId: s!.id, after: v, ip }, tx); return s!; }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "segment_name_taken" }); throw e; }
  }
  async deleteSegment(orgId: string, actorId: string, id: string, ip: string | null) {
    const used = await this.db.select({ id: campaign.id }).from(campaign).where(and(eq(campaign.segmentId, id), eq(campaign.orgId, orgId))).limit(1); if (used.length) throw new ConflictException({ code: "segment_in_use" });
    const r = await this.db.delete(segment).where(and(eq(segment.id, id), eq(segment.orgId, orgId))).returning({ id: segment.id }); if (!r.length) throw new NotFoundException({ code: "segment_not_found" }); await this.audit.record({ orgId, actorId, action: "segment.delete", subjectType: "segment", subjectId: id, ip }); return { id };
  }

  // ------------------------------------------------------------ the one rule about who may be emailed
  private async audienceOf(orgId: string, people: Awaited<ReturnType<MarketingService["facts"]>>, now: Date): Promise<Audience> {
    const gap = (await this.settings(orgId)).minGapDays; const last = await this.lastSent(orgId); const a: Audience = { matched: people.length, eligible: 0, skipped: { no_consent: 0, no_email: 0, frequency: 0 } };
    for (const c of people) { const b = sendBlock({ email: c.email, consentEmail: c.consentEmail, lastMarketingAt: last.get(c.id) ?? null, minGapDays: gap, now }); if (b) a.skipped[b]++; else a.eligible++; } return a;
  }
  private footer(orgName: string, customerId: string) { return `\n\n--\nYou are getting this because you agreed to hear from ${orgName}.\nUnsubscribe with one click: ${this.unsubscribeUrl(customerId)}\n`; }

  // ------------------------------------------------------------ campaigns
  async listCampaigns(orgId: string) { const rows = await this.db.select({ c: campaign, seg: segment.name }).from(campaign).leftJoin(segment, eq(segment.id, campaign.segmentId)).where(eq(campaign.orgId, orgId)).orderBy(desc(campaign.createdAt)); return rows.map(({ c, seg }) => ({ ...c, segment: seg ?? "Everyone" })); }
  async createCampaign(orgId: string, actorId: string, v: { name: string; segmentId: string | null; subject: string; body: string }, ip: string | null) {
    if (v.segmentId) { const [s] = await this.db.select({ id: segment.id }).from(segment).where(and(eq(segment.id, v.segmentId), eq(segment.orgId, orgId))); if (!s) throw new NotFoundException({ code: "segment_not_found" }); }
    return this.db.transaction(async (tx) => { const [c] = await tx.insert(campaign).values({ orgId, ...v, createdBy: actorId }).returning(); await this.audit.record({ orgId, actorId, action: "campaign.create", subjectType: "campaign", subjectId: c!.id, after: { name: v.name, segmentId: v.segmentId }, ip }, tx); return c!; });
  }
  private async draft(orgId: string, id: string) { const [c] = await this.db.select().from(campaign).where(and(eq(campaign.id, id), eq(campaign.orgId, orgId))); if (!c) throw new NotFoundException({ code: "campaign_not_found" }); return c; }
  async updateCampaign(orgId: string, actorId: string, id: string, patch: Partial<{ name: string; segmentId: string | null; subject: string; body: string }>, ip: string | null) {
    const c = await this.draft(orgId, id); if (c.status !== "draft") throw new ConflictException({ code: "not_a_draft", status: c.status });
    const [u] = await this.db.update(campaign).set(patch).where(and(eq(campaign.id, id), eq(campaign.status, "draft"))).returning(); if (!u) throw new ConflictException({ code: "not_a_draft" }); await this.audit.record({ orgId, actorId, action: "campaign.update", subjectType: "campaign", subjectId: id, ip }); return u;
  }
  async campaignAudience(orgId: string, id: string, now = new Date()) { const c = await this.draft(orgId, id); const all = await this.facts(orgId); const seg = c.segmentId ? (await this.db.select().from(segment).where(eq(segment.id, c.segmentId)))[0] : null; return this.audienceOf(orgId, all.filter((p) => !seg || matchSegment(seg.rules as Rules, p.facts, now)), now); }
  /** Sends to everyone allowed, records everyone skipped and why. The row is locked and moved to `sending` first, so a double click or two workers cannot send it twice, and each person has a unique row for the campaign. */
  async sendCampaign(orgId: string, actorId: string, id: string, ip: string | null, now = new Date()) {
    const claimed = await this.db.update(campaign).set({ status: "sending" }).where(and(eq(campaign.id, id), eq(campaign.orgId, orgId), eq(campaign.status, "draft"))).returning(); if (!claimed.length) { const c = await this.draft(orgId, id); throw new ConflictException({ code: "not_a_draft", status: c.status }); }
    const c = claimed[0]!; const [o] = await this.db.select({ name: org.name }).from(org).where(eq(org.id, orgId)); const gap = (await this.settings(orgId)).minGapDays; const last = await this.lastSent(orgId); const all = await this.facts(orgId); const seg = c.segmentId ? (await this.db.select().from(segment).where(eq(segment.id, c.segmentId)))[0] : null;
    const people = all.filter((p) => !seg || matchSegment(seg.rules as Rules, p.facts, now)); const stat = { matched: people.length, sent: 0, skipped: { no_consent: 0, no_email: 0, frequency: 0 } }; const standing = new Map<string, number>();
    try {
      for (const p of people) {
        const block = sendBlock({ email: p.email, consentEmail: p.consentEmail, lastMarketingAt: last.get(p.id) ?? null, minGapDays: gap, now });
        const subject = render(c.subject, { name: p.name, tier: p.facts.tier });
        const [row] = await this.db.insert(marketingMessage).values({ orgId, campaignId: id, customerId: p.id, email: p.email, subject, status: block ? "skipped" : "sent", skipReason: block }).onConflictDoNothing().returning({ id: marketingMessage.id });
        if (block) { stat.skipped[block]++; continue; } if (!row) continue;
        const pts = standing.get(p.id) ?? (await this.loyalty.balance(orgId, p.id)); standing.set(p.id, pts);
        await this.mail.send(orgId, { to: p.email!, subject, body: render(c.body, { name: p.name, points: pts, tier: p.facts.tier }) + this.footer(o!.name, p.id), kind: "marketing" }); stat.sent++;
      }
    } catch (e) { await this.db.update(campaign).set({ status: "draft" }).where(eq(campaign.id, id)); throw e; }
    await this.db.update(campaign).set({ status: "sent", sentAt: now, audience: stat as never }).where(eq(campaign.id, id)); await this.audit.record({ orgId, actorId, action: "campaign.send", subjectType: "campaign", subjectId: id, after: stat, ip }); return stat;
  }
  async cancelCampaign(orgId: string, actorId: string, id: string, ip: string | null) { const r = await this.db.update(campaign).set({ status: "cancelled" }).where(and(eq(campaign.id, id), eq(campaign.orgId, orgId), eq(campaign.status, "draft"))).returning({ id: campaign.id }); if (!r.length) throw new ConflictException({ code: "not_a_draft" }); await this.audit.record({ orgId, actorId, action: "campaign.cancel", subjectType: "campaign", subjectId: id, ip }); return { id, status: "cancelled" }; }
  async messages(orgId: string, campaignId: string) { await this.draft(orgId, campaignId); return (await this.db.select({ m: marketingMessage, name: customer.name }).from(marketingMessage).innerJoin(customer, eq(customer.id, marketingMessage.customerId)).where(eq(marketingMessage.campaignId, campaignId)).orderBy(asc(customer.name)).limit(500)).map(({ m, name }) => ({ customer: name, email: m.email, status: m.status, skipReason: m.skipReason })); }

  // ------------------------------------------------------------ flows
  async flows(orgId: string) {
    for (const [kind, d] of Object.entries(FLOW_DEFAULTS)) await this.db.insert(flow).values({ orgId, kind, name: d.name, config: d.config as never }).onConflictDoNothing();
    const rows = await this.db.select().from(flow).where(eq(flow.orgId, orgId)); const sent = new Map(((await this.db.execute(sql`select flow_id::text as f, count(*)::int as n from shelfline.marketing_message where org_id = ${orgId} and flow_id is not null and status = 'sent' group by 1`)).rows as Row[]).map((r) => [String(r.f), Number(r.n)]));
    return rows.sort((a, b) => a.kind.localeCompare(b.kind)).map((f) => ({ id: f.id, kind: f.kind, name: f.name, active: f.active, config: f.config as FlowConfig, sent: sent.get(f.id) ?? 0 }));
  }
  async updateFlow(orgId: string, actorId: string, id: string, patch: { active?: boolean; config?: Partial<FlowConfig> }, ip: string | null) {
    const [f] = await this.db.select().from(flow).where(and(eq(flow.id, id), eq(flow.orgId, orgId))); if (!f) throw new NotFoundException({ code: "flow_not_found" });
    const cfg = { ...(f.config as FlowConfig), ...(patch.config ?? {}) }; if ((f.kind === "win_back" && !(cfg.inactiveDays! >= 7)) || (f.kind === "post_purchase" && !(cfg.afterDays! >= 1))) throw new BadRequestException({ code: "bad_timing" });
    const [u] = await this.db.update(flow).set({ ...(patch.active !== undefined ? { active: patch.active } : {}), config: cfg as never }).where(eq(flow.id, id)).returning(); await this.audit.record({ orgId, actorId, action: "flow.update", subjectType: "flow", subjectId: id, after: { active: u!.active, kind: f.kind }, ip }); return { id, active: u!.active, config: u!.config };
  }
  async runAllFlows(now = new Date()) { const orgs = await this.db.select({ id: org.id }).from(org); let n = 0; for (const o of orgs) n += (await this.runFlows(o.id, now)).sent; return n; }
  /** Looks for people each active flow applies to and sends once per reason. Running it again, or twice at once, sends nothing new. */
  async runFlows(orgId: string, now = new Date()) {
    const active = (await this.db.select().from(flow).where(and(eq(flow.orgId, orgId), eq(flow.active, true)))); if (!active.length) return { sent: 0, bonuses: 0 };
    const [o] = await this.db.select({ name: org.name, tz: org.timezoneDefault }).from(org).where(eq(org.id, orgId)); const gap = (await this.settings(orgId)).minGapDays; const last = await this.lastSent(orgId); const all = await this.facts(orgId); const prog = await this.loyalty.program(orgId);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: o!.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).reduce((a, p) => ({ ...a, [p.type]: p.value }), {} as Record<string, string>); const today = { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
    let sent = 0, bonuses = 0;
    const deliver = async (f: typeof active[number], p: (typeof all)[number], key: string) => {
      const block = sendBlock({ email: p.email, consentEmail: p.consentEmail, lastMarketingAt: last.get(p.id) ?? null, minGapDays: gap, now }); if (block) return;      // not recorded, so a held-back one is tried again next time
      const c = f.config as FlowConfig; const subject = render(c.subject, { name: p.name, tier: p.facts.tier });
      const [row] = await this.db.insert(marketingMessage).values({ orgId, flowId: f.id, flowKey: key, customerId: p.id, email: p.email, subject, status: "sent" }).onConflictDoNothing().returning({ id: marketingMessage.id }); if (!row) return;
      await this.mail.send(orgId, { to: p.email!, subject, body: render(c.body, { name: p.name, points: await this.loyalty.balance(orgId, p.id), tier: p.facts.tier }) + this.footer(o!.name, p.id), kind: "marketing" }); last.set(p.id, now); sent++;
    };
    for (const f of active) {
      const c = f.config as FlowConfig;
      if (f.kind === "win_back") for (const p of all) { if (p.orders > 0 && p.lastAt && matchSegment({ lastPurchaseBeforeDays: c.inactiveDays }, p.facts, now)) await deliver(f, p, `wb:${p.lastAt.toISOString().slice(0, 10)}`); }
      if (f.kind === "birthday") for (const p of all) { if (p.facts.birthMonth === today.m && p.birthDay === today.d) { if (prog.enabled && prog.birthdayBonus > 0 && (await this.db.transaction((tx) => this.loyalty.bonusIn(tx, orgId, p.id, prog.birthdayBonus, "birthday", String(today.y), "Birthday bonus")))) bonuses++; await deliver(f, p, `bday:${today.y}`); } }
      if (f.kind === "post_purchase") {
        const lo = new Date(now.getTime() - (c.afterDays! + 2) * 86_400_000), hi = new Date(now.getTime() - c.afterDays! * 86_400_000); const by = new Map(all.map((p) => [p.id, p]));
        const sales = (await this.db.execute(sql`select id::text as id, customer_id::text as cid from shelfline.sale where org_id = ${orgId} and customer_id is not null and status in ('completed','partially_refunded') and effective_at > ${lo.toISOString()}::timestamptz and effective_at <= ${hi.toISOString()}::timestamptz order by effective_at`)).rows as Row[];
        for (const s of sales) { const p = by.get(String(s.cid)); if (p) await deliver(f, p, `pp:${s.id}`); }
      }
    }
    return { sent, bonuses };
  }
}
