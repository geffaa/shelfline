import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { cardPayment, cardReader, device, location, org } from "../db/schema";
import { SimulatedCardProvider, StripeTerminalProvider, type CardProvider } from "./provider";

const STALE_MS = 10 * 60_000;
export interface ReaderIn { locationId: string; registerId?: string | null; name: string; providerReaderId: string; active: boolean }

@Injectable()
export class CardsService {
  readonly provider: CardProvider;
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) cfg: Config, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {
    this.provider = cfg.cardProvider === "stripe" ? new StripeTerminalProvider(cfg.stripeSecretKey, cfg.stripeApiBase) : new SimulatedCardProvider(cfg.simulatedCardDelayMs);
  }
  private async need(userId: string, locationId: string) { if (!(await this.authz.can(userId, "device:manage", locationId))) throw new ForbiddenException({ code: "forbidden", permission: "device:manage", locationId }); }

  // ------------------------------------------------------------ readers (back office)
  async createReader(orgId: string, actorId: string, v: ReaderIn, ip: string | null) {
    await this.need(actorId, v.locationId); const [l] = await this.db.select({ id: location.id }).from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    try { return await this.db.transaction(async (tx) => { const [r] = await tx.insert(cardReader).values({ orgId, ...v, registerId: v.registerId ?? null }).returning(); await this.audit.record({ orgId, actorId, action: "card_reader.create", subjectType: "card_reader", subjectId: r!.id, after: v, ip }, tx); return r!; }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "reader_name_taken" }); throw e; }
  }
  async updateReader(orgId: string, actorId: string, id: string, patch: Partial<Omit<ReaderIn, "locationId">>, ip: string | null) {
    const [cur] = await this.db.select().from(cardReader).where(and(eq(cardReader.id, id), eq(cardReader.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "reader_not_found" }); await this.need(actorId, cur.locationId);
    const [r] = await this.db.update(cardReader).set(patch).where(eq(cardReader.id, id)).returning(); await this.audit.record({ orgId, actorId, action: "card_reader.update", subjectType: "card_reader", subjectId: id, after: patch, ip }); return r!;
  }
  async listReaders(orgId: string, userId: string) {
    const sc = await this.authz.scope(userId, "device:manage"); const rows = await this.db.select({ r: cardReader, l: location.name }).from(cardReader).innerJoin(location, eq(location.id, cardReader.locationId)).where(eq(cardReader.orgId, orgId)).orderBy(asc(location.name), asc(cardReader.name));
    return rows.filter(({ r }) => sc.all || sc.locationIds.includes(r.locationId)).map(({ r, l }) => ({ ...r, location: l, provider: this.provider.name }));
  }
  async payments(orgId: string, userId: string) {
    const sc = await this.authz.scope(userId, "device:manage"); const rows = await this.db.select({ p: cardPayment, l: location.name, r: cardReader.name }).from(cardPayment).innerJoin(location, eq(location.id, cardPayment.locationId)).innerJoin(cardReader, eq(cardReader.id, cardPayment.readerId)).where(eq(cardPayment.orgId, orgId)).orderBy(desc(cardPayment.createdAt)).limit(100);
    return rows.filter(({ p }) => sc.all || sc.locationIds.includes(p.locationId)).map(({ p, l, r }) => ({ id: p.id, location: l, reader: r, amountMinor: p.amountMinor, status: p.status, failure: p.failure, brand: p.brand, last4: p.last4, saleId: p.saleId, createdAt: p.createdAt, completedAt: p.completedAt, provider: p.provider }));
  }

  // ------------------------------------------------------------ the till takes a card payment
  private shape(p: typeof cardPayment.$inferSelect) { return { id: p.id, status: p.status, amountMinor: p.amountMinor, failure: p.failure, brand: p.brand, last4: p.last4, reference: `cp:${p.id}${p.last4 ? ` ····${p.last4}` : ""}`, provider: p.provider }; }
  async start(orgId: string, userId: string, deviceId: string, v: { amountMinor: number; idempotencyKey: string }) {
    const [dup] = await this.db.select().from(cardPayment).where(and(eq(cardPayment.orgId, orgId), eq(cardPayment.idempotencyKey, v.idempotencyKey))); if (dup) return this.shape(dup);
    const [d] = await this.db.select().from(device).where(eq(device.id, deviceId)); if (!d) throw new ForbiddenException({ code: "device_unknown" });
    const readers = await this.db.select().from(cardReader).where(and(eq(cardReader.orgId, orgId), eq(cardReader.locationId, d.locationId), eq(cardReader.active, true), d.registerId ? or(eq(cardReader.registerId, d.registerId), isNull(cardReader.registerId)) : isNull(cardReader.registerId))).orderBy(asc(cardReader.name));
    const reader = readers.find((r) => d.registerId && r.registerId === d.registerId) ?? readers.find((r) => r.registerId === null); if (!reader) throw new ConflictException({ code: "no_reader" });
    const [o] = await this.db.select({ c: org.currency }).from(org).where(eq(org.id, orgId));
    const [row] = await this.db.insert(cardPayment).values({ orgId, locationId: d.locationId, registerId: d.registerId, readerId: reader.id, amountMinor: v.amountMinor, currency: o!.c, provider: this.provider.name, requestedBy: userId, idempotencyKey: v.idempotencyKey }).onConflictDoNothing().returning();
    if (!row) { const [again] = await this.db.select().from(cardPayment).where(and(eq(cardPayment.orgId, orgId), eq(cardPayment.idempotencyKey, v.idempotencyKey))); return this.shape(again!); }
    try { const { providerRef } = await this.provider.send({ amountMinor: v.amountMinor, currency: o!.c, readerId: reader.providerReaderId, idempotencyKey: v.idempotencyKey, reference: row.id }); const [r] = await this.db.update(cardPayment).set({ providerRef }).where(eq(cardPayment.id, row.id)).returning(); return this.shape(r!); }
    catch (e) { const [r] = await this.db.update(cardPayment).set({ status: "failed", failure: `provider_error: ${String(e).slice(0, 120)}`, completedAt: new Date() }).where(eq(cardPayment.id, row.id)).returning(); return this.shape(r!); }
  }
  private async load(orgId: string, id: string, deviceId: string) {
    const [p] = await this.db.select().from(cardPayment).where(and(eq(cardPayment.id, id), eq(cardPayment.orgId, orgId))); if (!p) throw new NotFoundException({ code: "card_payment_not_found" });
    const [d] = await this.db.select({ l: device.locationId }).from(device).where(eq(device.id, deviceId)); if (!d || d.l !== p.locationId) throw new ForbiddenException({ code: "other_location" }); return p;
  }
  /** Asks the backend how it is going and keeps the answer. A payment still waiting after ten minutes is called off: nobody is standing at the terminal. */
  async get(orgId: string, deviceId: string, id: string) {
    const p = await this.load(orgId, id, deviceId); if (p.status !== "processing" || !p.providerRef) return this.shape(p);
    const [reader] = await this.db.select().from(cardReader).where(eq(cardReader.id, p.readerId)); const ctx = { createdAt: p.createdAt, amountMinor: p.amountMinor, readerId: reader!.providerReaderId };
    let out = await this.provider.status(p.providerRef, ctx).catch(() => ({ status: "processing" as const }));
    if (out.status === "processing" && Date.now() - p.createdAt.getTime() > STALE_MS) { await this.provider.cancel(p.providerRef, ctx).catch(() => undefined); out = { status: "failed", failure: "timed_out" } as never; }
    if (out.status === "processing") return this.shape(p);
    const [r] = await this.db.update(cardPayment).set({ status: out.status, failure: (out as { failure?: string }).failure ?? null, brand: (out as { brand?: string }).brand ?? null, last4: (out as { last4?: string }).last4 ?? null, completedAt: new Date() }).where(and(eq(cardPayment.id, id), eq(cardPayment.status, "processing"))).returning();
    return this.shape(r ?? (await this.load(orgId, id, deviceId)));
  }
  async cancel(orgId: string, deviceId: string, id: string) {
    const p = await this.load(orgId, id, deviceId); if (p.status === "succeeded") throw new ConflictException({ code: "already_paid" }); if (p.status !== "processing") return this.shape(p);
    const [reader] = await this.db.select().from(cardReader).where(eq(cardReader.id, p.readerId)); if (p.providerRef) await this.provider.cancel(p.providerRef, { readerId: reader!.providerReaderId }).catch(() => undefined);
    const [r] = await this.db.update(cardPayment).set({ status: "canceled", completedAt: new Date() }).where(and(eq(cardPayment.id, id), eq(cardPayment.status, "processing"))).returning(); return this.shape(r ?? (await this.load(orgId, id, deviceId)));
  }
}
