import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { AuthzService } from "../auth/authz.service";
import { DB, type Db } from "../db/db.module";
import { device, location, org, printJob, printer, register, user } from "../db/schema";
import { decodeEscPos } from "./escpos";
import { drawerBytes, renderReceipt, testPage, type ReceiptData } from "./receipt";

type Row = Record<string, unknown>;
export interface PrinterIn { locationId: string; registerId?: string | null; name: string; host: string; port: number; columns: number; active: boolean }
const MAX_ATTEMPTS = 3, CLAIM_TIMEOUT_S = 60;
/** Only addresses that mean "a printer on the store network": a literal IPv4 address or a host name. Not a URL, not an address that would make the bridge talk to something else. */
export const validHost = (h: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) ? h.split(".").every((n) => Number(n) <= 255) : /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);

@Injectable()
export class PrintingService {
  constructor(@Inject(DB) private db: Db, @Inject(AuditService) private audit: AuditService, @Inject(AuthzService) private authz: AuthzService) {}
  private async need(userId: string, locationId: string) { if (!(await this.authz.can(userId, "device:manage", locationId))) throw new ForbiddenException({ code: "forbidden", permission: "device:manage", locationId }); }

  // ------------------------------------------------------------ printers (back office)
  async create(orgId: string, actorId: string, v: PrinterIn, ip: string | null) {
    await this.need(actorId, v.locationId); if (!validHost(v.host)) throw new BadRequestException({ code: "bad_host" });
    const [l] = await this.db.select({ id: location.id }).from(location).where(and(eq(location.id, v.locationId), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" });
    if (v.registerId) { const [r] = await this.db.select({ id: register.id }).from(register).where(and(eq(register.id, v.registerId), eq(register.locationId, v.locationId))); if (!r) throw new NotFoundException({ code: "register_not_found" }); }
    try { return await this.db.transaction(async (tx) => { const [p] = await tx.insert(printer).values({ orgId, ...v, registerId: v.registerId ?? null }).returning(); await this.audit.record({ orgId, actorId, action: "printer.create", subjectType: "printer", subjectId: p!.id, after: v, ip }, tx); return p!; }); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "23505") throw new ConflictException({ code: "printer_name_taken" }); throw e; }
  }
  async update(orgId: string, actorId: string, id: string, patch: Partial<Omit<PrinterIn, "locationId">>, ip: string | null) {
    const [cur] = await this.db.select().from(printer).where(and(eq(printer.id, id), eq(printer.orgId, orgId))); if (!cur) throw new NotFoundException({ code: "printer_not_found" }); await this.need(actorId, cur.locationId);
    if (patch.host !== undefined && !validHost(patch.host)) throw new BadRequestException({ code: "bad_host" });
    const [p] = await this.db.update(printer).set(patch).where(eq(printer.id, id)).returning(); await this.audit.record({ orgId, actorId, action: "printer.update", subjectType: "printer", subjectId: id, after: patch, ip }); return p!;
  }
  async list(orgId: string, userId: string) {
    const sc = await this.authz.scope(userId, "device:manage"); if (!sc.all && !sc.locationIds.length) return [];
    const w = sc.all ? sql`true` : sql`p.location_id in (${sql.join(sc.locationIds.map((i) => sql`${i}::uuid`), sql`, `)})`;
    const rows = (await this.db.execute(sql`select p.*, l.name as location, r.name as register,
        (select count(*)::int from shelfline.print_job j where j.printer_id = p.id and j.status in ('queued','sending')) as waiting, (select count(*)::int from shelfline.print_job j where j.printer_id = p.id and j.status = 'failed') as failed
      from shelfline.printer p join shelfline.location l on l.id = p.location_id left join shelfline.register r on r.id = p.register_id where p.org_id = ${orgId} and ${w} order by l.name, p.name`)).rows as Row[];
    return rows.map((r) => ({ id: r.id, locationId: r.location_id, location: r.location, registerId: r.register_id, register: r.register ?? null, name: r.name, host: r.host, port: r.port, columns: r.columns, active: r.active, lastOkAt: r.last_ok_at, lastError: r.last_error, waiting: r.waiting, failed: r.failed }));
  }
  async jobs(orgId: string, userId: string, locationId?: string) {
    const sc = await this.authz.scope(userId, "device:manage"); const rows = await this.db.select({ j: printJob, p: printer.name, l: location.name }).from(printJob).innerJoin(printer, eq(printer.id, printJob.printerId)).innerJoin(location, eq(location.id, printJob.locationId))
      .where(and(eq(printJob.orgId, orgId), locationId ? eq(printJob.locationId, locationId) : undefined)).orderBy(desc(printJob.createdAt)).limit(100);
    return rows.filter((r) => sc.all || sc.locationIds.includes(r.j.locationId)).map(({ j, p, l }) => ({ id: j.id, kind: j.kind, printer: p, location: l, status: j.status, attempts: j.attempts, lastError: j.lastError, copy: j.copy, createdAt: j.createdAt, doneAt: j.doneAt }));
  }
  async retry(orgId: string, actorId: string, id: string, ip: string | null) {
    const [j] = await this.db.select().from(printJob).where(and(eq(printJob.id, id), eq(printJob.orgId, orgId))); if (!j) throw new NotFoundException({ code: "job_not_found" }); await this.need(actorId, j.locationId);
    if (j.status !== "failed") throw new ConflictException({ code: "not_failed" }); await this.db.update(printJob).set({ status: "queued", attempts: 0, lastError: null }).where(eq(printJob.id, id));
    await this.audit.record({ orgId, actorId, action: "print_job.retry", subjectType: "print_job", subjectId: id, ip }); return { id, status: "queued" };
  }
  async testPrint(orgId: string, actorId: string, id: string, ip: string | null) {
    const [p] = await this.db.select().from(printer).where(and(eq(printer.id, id), eq(printer.orgId, orgId))); if (!p) throw new NotFoundException({ code: "printer_not_found" }); await this.need(actorId, p.locationId);
    const jobId = await this.enqueue(p, "test", "test", crypto.randomUUID(), testPage(p.name, p.columns), actorId); await this.audit.record({ orgId, actorId, action: "printer.test", subjectType: "printer", subjectId: id, ip }); return { jobId };
  }

  // ------------------------------------------------------------ the till asks
  private async printerFor(orgId: string, locationId: string, registerId: string | null) {
    const rows = await this.db.select().from(printer).where(and(eq(printer.orgId, orgId), eq(printer.locationId, locationId), eq(printer.active, true), registerId ? or(eq(printer.registerId, registerId), isNull(printer.registerId)) : isNull(printer.registerId))).orderBy(asc(printer.name));
    const mine = rows.find((r) => r.registerId === registerId && registerId !== null); return mine ?? rows.find((r) => r.registerId === null) ?? null;
  }
  private async enqueue(p: typeof printer.$inferSelect, kind: "receipt" | "drawer" | "test", sourceType: string, sourceId: string, bytes: Uint8Array, by: string | null, copy = 1) {
    const [j] = await this.db.insert(printJob).values({ orgId: p.orgId, locationId: p.locationId, printerId: p.id, kind, sourceType, sourceId, copy, payloadBase64: Buffer.from(bytes).toString("base64"), requestedBy: by }).onConflictDoNothing().returning({ id: printJob.id });
    if (j) return j.id; const [e] = await this.db.select({ id: printJob.id }).from(printJob).where(and(eq(printJob.printerId, p.id), eq(printJob.sourceType, sourceType), eq(printJob.sourceId, sourceId), eq(printJob.kind, kind), eq(printJob.copy, copy))); return e!.id;
  }
  /** A receipt for a sale that has reached the server, from the till that sold it or another till in the same store. Each request makes a new copy, and copies after the first say COPY. */
  async printReceipt(orgId: string, userId: string, deviceId: string, saleId: string) {
    const [d] = await this.db.select().from(device).where(eq(device.id, deviceId)); if (!d) throw new ForbiddenException({ code: "device_unknown" });
    const [s] = (await this.db.execute(sql`select s.id, s.receipt_no, s.client_ts, s.effective_at, s.location_id, s.subtotal_minor, s.discount_minor, s.tax_minor, s.total_minor, s.rounding_minor, rg.name as register, l.name as location, l.timezone, u.name as cashier
      from shelfline.sale s join shelfline.register rg on rg.id = s.register_id join shelfline.location l on l.id = s.location_id left join shelfline."user" u on u.id = s.cashier_id where s.id = ${saleId} and s.org_id = ${orgId}`)).rows as Row[];
    if (!s) throw new NotFoundException({ code: "sale_not_found" }); if (s.location_id !== d.locationId) throw new ForbiddenException({ code: "other_location" });
    const p = await this.printerFor(orgId, d.locationId, d.registerId); if (!p) throw new ConflictException({ code: "no_printer" });
    const lines = (await this.db.execute(sql`select pr.title, v.options, sl.qty, sl.unit_price_minor, sl.discount_minor, sl.promo_discount_minor, sl.total_minor from shelfline.sale_line sl join shelfline.variant v on v.id = sl.variant_id join shelfline.product pr on pr.id = v.product_id where sl.sale_id = ${saleId} order by sl.line_no`)).rows as Row[];
    const pays = (await this.db.execute(sql`select tender, amount_minor, change_minor, reference from shelfline.payment where sale_id = ${saleId} order by id`)).rows as Row[];
    const copies = Number((await this.db.execute(sql`select count(*)::int as n from shelfline.print_job where source_type = 'sale' and source_id = ${saleId} and kind = 'receipt'`)).rows[0]!.n) + 1;
    const [o] = await this.db.select({ name: org.name }).from(org).where(eq(org.id, orgId));
    const at = new Intl.DateTimeFormat("en-AU", { timeZone: String(s.timezone), weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(String(s.effective_at ?? s.client_ts))).replace(",", "");
    const data: ReceiptData = { org: o!.name, location: String(s.location), register: String(s.register), receiptNo: String(s.receipt_no), at, cashier: String(s.cashier ?? ""), copy: copies, columns: p.columns,
      lines: lines.map((l) => ({ title: String(l.title), options: Object.values((l.options ?? {}) as Record<string, string>).join(" · ") || undefined, qty: Number(l.qty), unitMinor: Number(l.unit_price_minor), discountMinor: Number(l.discount_minor) + Number(l.promo_discount_minor), totalMinor: Number(l.total_minor) })),
      subtotalMinor: Number(s.subtotal_minor), discountMinor: Number(s.discount_minor), taxMinor: Number(s.tax_minor), totalMinor: Number(s.total_minor), roundingMinor: Number(s.rounding_minor),
      payments: pays.map((x) => ({ tender: String(x.tender), amountMinor: Number(x.amount_minor), changeMinor: Number(x.change_minor), reference: (x.reference as string | null) ?? null })), footer: "Thank you for shopping with us." };
    const jobId = await this.enqueue(p, "receipt", "sale", saleId, renderReceipt(data), userId, copies); return { jobId, printer: p.name, copy: copies };
  }
  async openDrawer(orgId: string, userId: string, deviceId: string, reason: string) {
    const [d] = await this.db.select().from(device).where(eq(device.id, deviceId)); if (!d) throw new ForbiddenException({ code: "device_unknown" });
    const p = await this.printerFor(orgId, d.locationId, d.registerId); if (!p) throw new ConflictException({ code: "no_printer" });
    const jobId = await this.enqueue(p, "drawer", reason, crypto.randomUUID(), drawerBytes(), userId); return { jobId, printer: p.name };
  }

  // ------------------------------------------------------------ the bridge asks (signed requests)
  /** Hands over queued jobs for printers at the bridge's store. A job handed over and never reported on goes back to the queue after a minute. */
  async claim(b: { id: string; orgId: string; locationId: string }, max: number) {
    await this.db.execute(sql`update shelfline.print_job set status = 'queued' where status = 'sending' and claimed_at < now() - make_interval(secs => ${CLAIM_TIMEOUT_S}) and location_id = ${b.locationId}`);
    const rows = (await this.db.execute(sql`update shelfline.print_job j set status = 'sending', attempts = j.attempts + 1, claimed_at = now() where j.id in (select j2.id from shelfline.print_job j2 join shelfline.printer p on p.id = j2.printer_id where j2.location_id = ${b.locationId} and j2.status = 'queued' and p.active order by j2.created_at limit ${max} for update of j2 skip locked) returning j.id, j.printer_id, j.kind, j.payload_base64, j.attempts`)).rows as Row[];
    if (!rows.length) return { jobs: [] };
    const ps = new Map((await this.db.select().from(printer).where(inArray(printer.id, [...new Set(rows.map((r) => String(r.printer_id)))]))).map((p) => [p.id, p]));
    return { jobs: rows.map((r) => ({ id: r.id, kind: r.kind, host: ps.get(String(r.printer_id))!.host, port: ps.get(String(r.printer_id))!.port, payload: r.payload_base64, attempt: r.attempts })) };
  }
  async result(b: { orgId: string; locationId: string }, id: string, ok: boolean, error?: string) {
    const [j] = await this.db.select().from(printJob).where(and(eq(printJob.id, id), eq(printJob.locationId, b.locationId))); if (!j) throw new NotFoundException({ code: "job_not_found" });
    if (j.status === "done") return { status: "done" };
    const status = ok ? "done" : j.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    await this.db.update(printJob).set({ status, lastError: ok ? null : (error ?? "unknown").slice(0, 200), doneAt: ok ? new Date() : null }).where(eq(printJob.id, id));
    await this.db.update(printer).set(ok ? { lastOkAt: new Date(), lastError: null } : { lastError: (error ?? "unknown").slice(0, 200) }).where(eq(printer.id, j.printerId));
    return { status };
  }
  /** What a job would print, for the screen and for tests. */
  preview(base64: string) { return decodeEscPos(Buffer.from(base64, "base64")); }
}
