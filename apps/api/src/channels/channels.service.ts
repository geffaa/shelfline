import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { CONFIG, type Config } from "../config";
import { decrypt, encrypt } from "../common/crypto";
import { DB, type Db } from "../db/db.module";
import { channelConnection, channelListing, channelOrder, channelWebhook, location, org, variant } from "../db/schema";
import { LedgerService } from "../inventory/ledger.service";
import { ShopifyClient, ShopifyError } from "./shopify.client";

export const DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
export interface ConnectIn { name: string; shopDomain: string; accessToken: string; webhookSecret: string; locationId: string; shopifyLocationId: string; apiVersion?: string }
export const hmacOf = (secret: string, raw: Buffer | string) => createHmac("sha256", secret).update(raw).digest("base64");
const safe = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const cents = (s: string | number | null | undefined) => Math.round(Number(s ?? 0) * 100);
interface WebhookLine { variant_id?: number | string | null; sku?: string | null; quantity: number; title?: string }

/** Shelfline stays the master of stock. Shopify orders take stock off the mapped store; absolute quantities are pushed back. Webhooks are verified, recognised if repeated, and applied once. */
@Injectable()
export class ChannelsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null; private logger = new Logger("channels");
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(LedgerService) private ledger: LedgerService, @Inject(AuditService) private audit: AuditService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.tick().catch((e) => this.logger.warn(`tick: ${String(e)}`)); }, 5 * 60_000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private client(c: typeof channelConnection.$inferSelect, fetchFn?: typeof fetch) { if (!c.accessTokenEnc) throw new ConflictException({ code: "disconnected" }); return new ShopifyClient({ domain: c.shopDomain, token: decrypt(c.accessTokenEnc, this.cfg.encryptionKey), version: c.apiVersion, base: this.cfg.shopifyApiBase || undefined, fetchFn }); }
  private async load(orgId: string, id: string) { const [c] = await this.db.select().from(channelConnection).where(and(eq(channelConnection.id, id), eq(channelConnection.orgId, orgId))); if (!c) throw new NotFoundException({ code: "channel_not_found" }); return c; }
  private shape(c: typeof channelConnection.$inferSelect) { const { accessTokenEnc, webhookSecretEnc, ...rest } = c; return { ...rest, hasToken: !!accessTokenEnc, webhookPath: `/channels/shopify/webhooks/${c.id}` }; }

  // ------------------------------------------------------------ connecting
  async connect(orgId: string, actorId: string, v: ConnectIn, ip: string | null) {
    const domain = v.shopDomain.trim().toLowerCase(); if (!DOMAIN.test(domain)) throw new BadRequestException({ code: "bad_shop_domain" });
    const [l] = await this.db.select({ id: location.id }).from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    const probe = new ShopifyClient({ domain, token: v.accessToken, version: v.apiVersion ?? "2025-10", base: this.cfg.shopifyApiBase || undefined });
    let shop: { name: string }; try { shop = await probe.shop(); } catch (e) { throw new ConflictException({ code: e instanceof ShopifyError && e.status === 401 ? "shopify_token_refused" : "shopify_unreachable" }); }
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx.insert(channelConnection).values({ orgId, name: v.name.trim() || shop.name, shopDomain: domain, accessTokenEnc: encrypt(v.accessToken, this.cfg.encryptionKey), webhookSecretEnc: encrypt(v.webhookSecret, this.cfg.encryptionKey), apiVersion: v.apiVersion ?? "2025-10", locationId: v.locationId, shopifyLocationId: v.shopifyLocationId, createdBy: actorId }).returning();
        await this.audit.record({ orgId, actorId, action: "channel.connect", subjectType: "channel_connection", subjectId: c!.id, after: { shop: domain, locationId: v.locationId }, ip }, tx); return this.shape(c!);
      });
    } catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "shop_already_connected" }); throw e; }
  }
  async list(orgId: string) {
    const rows = await this.db.select({ c: channelConnection, loc: location.name }).from(channelConnection).innerJoin(location, eq(location.id, channelConnection.locationId)).where(eq(channelConnection.orgId, orgId)).orderBy(desc(channelConnection.createdAt));
    const counts = new Map((await this.db.execute(sql`select connection_id::text as id, count(*)::int as n from shelfline.channel_listing group by 1`)).rows.map((r) => [String(r.id), Number(r.n)]));
    const orders = new Map((await this.db.execute(sql`select connection_id::text as id, count(*)::int as n, coalesce(sum(unmapped), 0)::int as un from shelfline.channel_order group by 1`)).rows.map((r) => [String(r.id), r]));
    return rows.map(({ c, loc }) => ({ ...this.shape(c), location: loc, listings: counts.get(c.id) ?? 0, orders: Number(orders.get(c.id)?.n ?? 0), unmappedLines: Number(orders.get(c.id)?.un ?? 0) }));
  }
  async setStatus(orgId: string, actorId: string, id: string, status: "active" | "paused" | "disconnected", ip: string | null) {
    const c = await this.load(orgId, id); const [u] = await this.db.update(channelConnection).set(status === "disconnected" ? { status, accessTokenEnc: null, webhookSecretEnc: null } : { status }).where(eq(channelConnection.id, id)).returning();
    await this.audit.record({ orgId, actorId, action: `channel.${status}`, subjectType: "channel_connection", subjectId: c.id, ip }); return this.shape(u!);
  }
  async listings(orgId: string, id: string) {
    await this.load(orgId, id); const rows = await this.db.select({ l: channelListing, sku: variant.sku }).from(channelListing).innerJoin(variant, eq(variant.id, channelListing.variantId)).where(eq(channelListing.connectionId, id)).orderBy(asc(variant.sku)).limit(500);
    return rows.map(({ l, sku }) => ({ id: l.id, sku, variantId: l.variantId, shopifyVariantId: l.shopifyVariantId, lastPushedQty: l.lastPushedQty, lastPushedAt: l.lastPushedAt }));
  }
  async orders(orgId: string, id: string) { await this.load(orgId, id); return (await this.db.select().from(channelOrder).where(eq(channelOrder.connectionId, id)).orderBy(desc(channelOrder.importedAt)).limit(100)).map((o) => ({ id: o.id, shopifyOrderId: o.shopifyOrderId, name: o.name, status: o.status, totalMinor: o.totalMinor, currency: o.currency, customerEmail: o.customerEmail, unmapped: o.unmapped, importedAt: o.importedAt, lines: o.lines })); }

  // ------------------------------------------------------------ mapping and stock
  /** Matches Shopify variants to Shelfline variants by SKU (ignoring case and spaces). Nothing is created on either side. */
  async importMap(orgId: string, actorId: string, id: string, ip: string | null, fetchFn?: typeof fetch) {
    const c = await this.load(orgId, id); const products = await this.client(c, fetchFn).products();
    const ours = await this.db.select({ id: variant.id, sku: variant.sku }).from(variant).where(eq(variant.orgId, orgId)); const bySku = new Map(ours.map((v) => [v.sku.trim().toLowerCase(), v.id]));
    const existing = await this.db.select().from(channelListing).where(eq(channelListing.connectionId, id)); const have = new Set(existing.map((e) => e.shopifyVariantId)); const haveOurs = new Set(existing.map((e) => e.variantId));
    const unmatched: { sku: string; title: string }[] = []; let added = 0; const fresh: (typeof channelListing.$inferInsert)[] = [];
    for (const p of products) for (const v of p.variants) {
      if (have.has(v.id)) continue; const vid = v.sku ? bySku.get(v.sku.toLowerCase()) : undefined;
      if (!vid || haveOurs.has(vid)) { unmatched.push({ sku: v.sku, title: `${p.title}${v.title && v.title !== "Default Title" ? ` · ${v.title}` : ""}` }); continue; }
      fresh.push({ connectionId: id, variantId: vid, shopifyVariantId: v.id, shopifyInventoryItemId: v.inventoryItemId }); haveOurs.add(vid); added++;
    }
    if (fresh.length) await this.db.insert(channelListing).values(fresh).onConflictDoNothing();
    await this.audit.record({ orgId, actorId, action: "channel.import", subjectType: "channel_connection", subjectId: id, detail: { added, unmatched: unmatched.length }, ip });
    return { shopifyVariants: products.reduce((a, p) => a + p.variants.length, 0), added, alreadyMapped: existing.length, unmatched };
  }
  private async held(c: typeof channelConnection.$inferSelect, variantIds: string[]) {
    if (!variantIds.length) return new Map<string, number>();
    const rows = await this.db.execute(sql`select variant_id::text as v, on_hand from shelfline.stock_balance where location_id = ${c.locationId} and variant_id in (${sql.join(variantIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    return new Map(rows.rows.map((r) => [String(r.v), Math.max(0, Number(r.on_hand))]));
  }
  /** Pushes the quantity we hold for every listing that differs from what we last pushed. Absolute numbers, so doing it twice changes nothing. */
  async push(orgId: string, id: string, o: { onlyVariantIds?: string[]; fetchFn?: typeof fetch } = {}) {
    const c = await this.load(orgId, id); if (c.status !== "active") return { pushed: 0, skipped: 0, failed: 0 };
    const client = this.client(c, o.fetchFn); const ls = (await this.db.select().from(channelListing).where(eq(channelListing.connectionId, id))).filter((l) => !o.onlyVariantIds || o.onlyVariantIds.includes(l.variantId));
    const qty = await this.held(c, ls.map((l) => l.variantId)); let pushed = 0, skipped = 0, failed = 0; let lastError: string | null = null;
    for (const l of ls) {
      const want = qty.get(l.variantId) ?? 0; if (l.lastPushedQty === want) { skipped++; continue; }
      try { await client.setInventory(c.shopifyLocationId, l.shopifyInventoryItemId, want); await this.db.update(channelListing).set({ lastPushedQty: want, lastPushedAt: new Date() }).where(eq(channelListing.id, l.id)); pushed++; }
      catch (e) { failed++; lastError = String(e).slice(0, 200); }
    }
    await this.db.update(channelConnection).set({ lastPushAt: new Date(), lastError }).where(eq(channelConnection.id, id)); return { pushed, skipped, failed };
  }
  /** Asks Shopify what it holds, compares with the ledger, and corrects any drift (someone edited it in Shopify, a push was lost). Afterwards Shopify equals the ledger. */
  async reconcile(orgId: string, actorId: string, id: string, ip: string | null, fetchFn?: typeof fetch) {
    const c = await this.load(orgId, id); const client = this.client(c, fetchFn); const ls = await this.db.select().from(channelListing).where(eq(channelListing.connectionId, id));
    const theirs = await client.levels(c.shopifyLocationId, ls.map((l) => l.shopifyInventoryItemId)); const ours = await this.held(c, ls.map((l) => l.variantId)); const drift: { variantId: string; ledger: number; shopify: number | null }[] = [];
    for (const l of ls) { const want = ours.get(l.variantId) ?? 0; const have = theirs.get(l.shopifyInventoryItemId); if (have !== want) { drift.push({ variantId: l.variantId, ledger: want, shopify: have ?? null }); try { await client.setInventory(c.shopifyLocationId, l.shopifyInventoryItemId, want); await this.db.update(channelListing).set({ lastPushedQty: want, lastPushedAt: new Date() }).where(eq(channelListing.id, l.id)); } catch (e) { drift[drift.length - 1]!.shopify = null; } } else if (l.lastPushedQty !== want) await this.db.update(channelListing).set({ lastPushedQty: want }).where(eq(channelListing.id, l.id)); }
    await this.audit.record({ orgId, actorId, action: "channel.reconcile", subjectType: "channel_connection", subjectId: id, detail: { listings: ls.length, drift: drift.length }, ip }); return { checked: ls.length, drift, fixed: drift.length };
  }
  async tick() { const cs = await this.db.select().from(channelConnection).where(eq(channelConnection.status, "active")); for (const c of cs) { if (c.accessTokenEnc) await this.push(c.orgId, c.id).catch((e) => this.logger.warn(`push ${c.shopDomain}: ${String(e)}`)); } }

  // ------------------------------------------------------------ webhooks
  /** Verifies the signature over the exact bytes Shopify sent, then applies the delivery once. Answers 200 for a delivery already seen so Shopify stops retrying it. */
  async webhook(connectionId: string, headers: { hmac?: string; topic?: string; webhookId?: string }, raw: Buffer | undefined) {
    const [c] = await this.db.select().from(channelConnection).where(eq(channelConnection.id, connectionId));
    if (!c || !c.webhookSecretEnc || c.status === "disconnected" || !raw || !headers.hmac) throw new UnauthorizedException({ code: "webhook_auth" });
    if (!safe(headers.hmac, hmacOf(decrypt(c.webhookSecretEnc, this.cfg.encryptionKey), raw))) throw new UnauthorizedException({ code: "webhook_auth" });
    const topic = headers.topic ?? ""; const wid = headers.webhookId ?? `body:${hmacOf("id", raw)}`;
    const [seen] = await this.db.insert(channelWebhook).values({ connectionId, webhookId: wid, topic, result: "received" }).onConflictDoNothing().returning({ id: channelWebhook.webhookId }); if (!seen) return { status: "duplicate" };
    let body: any; try { body = JSON.parse(raw.toString("utf8")); } catch { throw new BadRequestException({ code: "bad_json" }); }
    if (c.status === "paused") return { status: "paused" };
    if (topic === "orders/create" || topic === "orders/paid") return this.importOrder(c, body);
    if (topic === "orders/cancelled") return this.cancelOrder(c, body);
    return { status: "ignored", topic };
  }
  private async importOrder(c: typeof channelConnection.$inferSelect, o: { id: number | string; name?: string; currency?: string; total_price?: string; email?: string | null; line_items?: WebhookLine[] }) {
    const lines = o.line_items ?? []; const [currency] = await this.db.select({ c: org.currency }).from(org).where(eq(org.id, c.orgId));
    const ls = lines.length ? await this.db.select().from(channelListing).where(and(eq(channelListing.connectionId, c.id), inArray(channelListing.shopifyVariantId, lines.map((l) => String(l.variant_id ?? "")).filter(Boolean)))) : []; const by = new Map(ls.map((l) => [l.shopifyVariantId, l]));
    const mapped = lines.map((l) => ({ shopifyVariantId: l.variant_id == null ? null : String(l.variant_id), variantId: by.get(String(l.variant_id))?.variantId ?? null, sku: l.sku ?? "", title: l.title ?? "", qty: Math.max(0, Math.floor(l.quantity)) }));
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(channelOrder).values({ orgId: c.orgId, connectionId: c.id, shopifyOrderId: String(o.id), name: o.name ?? `#${o.id}`, totalMinor: cents(o.total_price), currency: (o.currency ?? currency!.c).slice(0, 3).toUpperCase(), customerEmail: o.email ?? null, lines: mapped, unmapped: mapped.filter((m) => !m.variantId).length }).onConflictDoNothing().returning();
      if (!row) return { status: "duplicate_order" };
      const moves = mapped.map((m, i) => ({ m, i })).filter(({ m }) => m.variantId && m.qty > 0);
      if (moves.length) await this.ledger.appendIn(tx, c.orgId, null, moves.map(({ m, i }) => ({ variantId: m.variantId!, locationId: c.locationId, qtyDelta: -m.qty, kind: "sale" as const, sourceType: "shopify_order", sourceId: row.id, lineNo: i, allowNegative: true })));
      return { status: "imported", orderId: row.id, unmapped: row.unmapped, variantIds: moves.map(({ m }) => m.variantId!) };
    }).then(async (r) => { if (r.status === "imported" && r.variantIds?.length) await this.push(c.orgId, c.id, { onlyVariantIds: r.variantIds }).catch(() => undefined); return r; });
  }
  private async cancelOrder(c: typeof channelConnection.$inferSelect, o: { id: number | string }) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(channelOrder).where(and(eq(channelOrder.connectionId, c.id), eq(channelOrder.shopifyOrderId, String(o.id)))).for("update"); if (!row) return { status: "unknown_order" }; if (row.status === "cancelled") return { status: "already_cancelled" };
      const lines = row.lines as { variantId: string | null; qty: number }[]; const back = lines.map((m, i) => ({ m, i })).filter(({ m }) => m.variantId && m.qty > 0);
      if (back.length) await this.ledger.appendIn(tx, c.orgId, null, back.map(({ m, i }) => ({ variantId: m.variantId!, locationId: c.locationId, qtyDelta: m.qty, kind: "refund_return" as const, sourceType: "shopify_order_cancel", sourceId: row.id, lineNo: i })));
      await tx.update(channelOrder).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(channelOrder.id, row.id)); return { status: "cancelled", orderId: row.id, variantIds: back.map(({ m }) => m.variantId!) };
    }).then(async (r) => { if (r.status === "cancelled" && r.variantIds?.length) await this.push(c.orgId, c.id, { onlyVariantIds: r.variantIds }).catch(() => undefined); return r; });
  }
}
