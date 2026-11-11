import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { decrypt, encrypt } from "../common/crypto";
import { CONFIG, type Config } from "../config";
import { DB, type Db } from "../db/db.module";
import { ACCOUNT_KEYS, accountMapping, accountingExport, location, xeroConnection } from "../db/schema";
import { ACCOUNT_LABEL, buildJournal, checksum, delta, major, reference, sum, xeroCsv, type AccountKey, type DayFigures, type Line } from "./journal";
import { refreshTokens, XeroClient, XeroError } from "./xero.client";

type Row = Record<string, unknown>;

@Injectable()
export class AccountingService {
  constructor(@Inject(DB) private db: Db, @Inject(CONFIG) private cfg: Config, @Inject(AuditService) private audit: AuditService) {}

  // ------------------------------------------------------------ the accounts
  async mappings(orgId: string) { const rows = await this.db.select().from(accountMapping).where(eq(accountMapping.orgId, orgId)); return ACCOUNT_KEYS.map((k) => ({ key: k, label: ACCOUNT_LABEL[k], code: rows.find((r) => r.key === k)?.code ?? null, name: rows.find((r) => r.key === k)?.name ?? null })); }
  async setMappings(orgId: string, actorId: string, items: { key: AccountKey; code: string; name?: string | null }[], ip: string | null) {
    await this.db.transaction(async (tx) => { for (const i of items) await tx.insert(accountMapping).values({ orgId, key: i.key, code: i.code.trim(), name: i.name?.trim() || null }).onConflictDoUpdate({ target: [accountMapping.orgId, accountMapping.key], set: { code: i.code.trim(), name: i.name?.trim() || null } }); await this.audit.record({ orgId, actorId, action: "accounting.mapping", subjectType: "org", subjectId: orgId, after: Object.fromEntries(items.map((i) => [i.key, i.code])), ip }, tx); });
    return this.mappings(orgId);
  }

  // ------------------------------------------------------------ the day, from the books
  private async loc(orgId: string, id: string) { const [l] = await this.db.select().from(location).where(and(eq(location.id, id), eq(location.orgId, orgId))); if (!l) throw new NotFoundException({ code: "location_not_found" }); return l; }
  async figures(orgId: string, locationId: string, date: string): Promise<DayFigures> {
    const L = sql`${locationId}::uuid`; const D = sql`${date}::date`; const okSale = sql`s.status in ('completed','partially_refunded','refunded')`;
    const s = ((await this.db.execute(sql`select coalesce(sum(total_minor), 0)::int as t, coalesce(sum(tax_minor), 0)::int as x, coalesce(sum(rounding_minor), 0)::int as r from shelfline.sale s where s.org_id = ${orgId} and s.location_id = ${L} and s.local_date = ${D} and ${okSale}`)).rows[0]) as Row;
    const pin = (await this.db.execute(sql`select p.tender, coalesce(sum(p.amount_minor), 0)::int as amt from shelfline.payment p join shelfline.sale s on s.id = p.sale_id where s.org_id = ${orgId} and s.location_id = ${L} and s.local_date = ${D} and ${okSale} group by 1`)).rows as Row[];
    const rf = ((await this.db.execute(sql`select coalesce(sum(total_minor), 0)::int as t, coalesce(sum(tax_minor), 0)::int as x from shelfline.refund where org_id = ${orgId} and location_id = ${L} and local_date = ${D}`)).rows[0]) as Row;
    const pout = (await this.db.execute(sql`select tender, coalesce(sum(total_minor), 0)::int as amt from shelfline.refund where org_id = ${orgId} and location_id = ${L} and local_date = ${D} group by 1`)).rows as Row[];
    const v = ((await this.db.execute(sql`select coalesce(sum(s.variance_minor), 0)::int as v from shelfline.register_session s join shelfline.location l on l.id = s.location_id where s.org_id = ${orgId} and s.location_id = ${L} and s.status in ('closed','force_closed') and (case when (s.opened_at at time zone l.timezone)::time >= l.day_cutoff then (s.opened_at at time zone l.timezone)::date else (s.opened_at at time zone l.timezone)::date - 1 end) = ${D}`)).rows[0]) as Row;
    const c = ((await this.db.execute(sql`select coalesce(sum(coalesce(sl.unit_cost_minor, 0) * sl.qty), 0)::bigint as c from shelfline.sale_line sl join shelfline.sale s on s.id = sl.sale_id where s.org_id = ${orgId} and s.location_id = ${L} and s.local_date = ${D} and ${okSale}`)).rows[0]) as Row;
    const cr = ((await this.db.execute(sql`select coalesce(sum(coalesce(sl.unit_cost_minor, 0) * rl.qty), 0)::bigint as c from shelfline.refund_line rl join shelfline.refund r on r.id = rl.refund_id join shelfline.sale_line sl on sl.sale_id = r.sale_id and sl.line_no = rl.sale_line_no where r.org_id = ${orgId} and r.location_id = ${L} and r.local_date = ${D} and rl.restock`)).rows[0]) as Row;
    return { salesTotalMinor: Number(s.t), salesTaxMinor: Number(s.x), roundingMinor: Number(s.r), tendersIn: Object.fromEntries(pin.map((r) => [String(r.tender), Number(r.amt)])), refundsTotalMinor: Number(rf.t), refundsTaxMinor: Number(rf.x), tendersOut: Object.fromEntries(pout.map((r) => [String(r.tender), Number(r.amt)])), varianceMinor: Number(v.v), cogsMinor: Number(c.c), cogsReturnedMinor: Number(cr.c) };
  }
  private async open(orgId: string, locationId: string, date: string) {
    return Number(((await this.db.execute(sql`select count(*)::int as n from shelfline.register_session s join shelfline.location l on l.id = s.location_id where s.org_id = ${orgId} and s.location_id = ${locationId}::uuid and s.status = 'open' and (case when (s.opened_at at time zone l.timezone)::time >= l.day_cutoff then (s.opened_at at time zone l.timezone)::date else (s.opened_at at time zone l.timezone)::date - 1 end) <= ${date}::date`)).rows[0] as { n: number }).n);
  }
  private async sent(orgId: string, locationId: string, date: string) { return this.db.select().from(accountingExport).where(and(eq(accountingExport.orgId, orgId), eq(accountingExport.locationId, locationId), eq(accountingExport.localDate, date))).orderBy(asc(accountingExport.version)); }
  private async codes(orgId: string) { return new Map((await this.db.select().from(accountMapping).where(eq(accountMapping.orgId, orgId))).map((m) => [m.key, m])); }

  /** The journal for one store and one day as it stands now, what has been sent, and what a send would add. */
  async day(orgId: string, locationId: string, date: string) {
    const l = await this.loc(orgId, locationId); const f = await this.figures(orgId, locationId, date); const j = buildJournal(f); const sent = await this.sent(orgId, locationId, date); const codes = await this.codes(orgId);
    const pending = delta(sent.map((s) => s.lines as Line[]), j.lines); const missing = [...new Set(pending.map((x) => x.account))].filter((k) => !codes.get(k)); const open = await this.open(orgId, locationId, date);
    const show = (ls: Line[]) => ls.map((x) => ({ account: x.account, label: ACCOUNT_LABEL[x.account], code: codes.get(x.account)?.code ?? null, description: x.description, debitMinor: x.amountMinor > 0 ? x.amountMinor : 0, creditMinor: x.amountMinor < 0 ? -x.amountMinor : 0 }));
    return { location: l.name, date, netSalesMinor: f.salesTotalMinor - f.refundsTotalMinor, lines: show(j.lines), balanced: sum(j.lines) === 0, unreconciledMinor: j.unreconciledMinor, openRegisters: open, missingAccounts: missing, versions: sent.map((s) => ({ id: s.id, version: s.version, method: s.method, reference: s.reference, externalRef: s.externalRef, exportedAt: s.exportedAt, lines: show(s.lines as Line[]) })),
      pending: show(pending), status: open > 0 ? "open" : sent.length === 0 ? (j.lines.length ? "ready" : "empty") : pending.length ? "changed" : "exported" };
  }
  async days(orgId: string, o: { locationId: string; from: string; to: string }) {
    const span = (Date.parse(o.to) - Date.parse(o.from)) / 86_400_000; if (!(span >= 0) || span > 62) throw new BadRequestException({ code: "bad_range" }); await this.loc(orgId, o.locationId); const out = [];
    for (let i = 0; i <= span; i++) { const d = new Date(Date.parse(o.from + "T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10); const r = await this.day(orgId, o.locationId, d); out.push({ date: d, status: r.status, balanced: r.balanced, unreconciledMinor: r.unreconciledMinor, versions: r.versions.length, netSalesMinor: r.netSalesMinor }); }
    return out.reverse();
  }

  // ------------------------------------------------------------ sending it
  /**
   * Version 1 is the whole day, once the day is closed. After that a send is only what changed, as an adjusting journal; if nothing changed, nothing is sent and nothing is recorded.
   * The (store, day, version) row is unique and the whole step runs under a lock for that day, so two people pressing the button at once produce one journal.
   */
  async export(orgId: string, actorId: string, v: { locationId: string; date: string; method: "xero" | "csv" }, ip: string | null, fetchFn?: typeof fetch) {
    const l = await this.loc(orgId, v.locationId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`acct:${v.locationId}:${v.date}`}))`);
      if (await this.open(orgId, v.locationId, v.date)) throw new ConflictException({ code: "day_not_closed" });
      const f = await this.figures(orgId, v.locationId, v.date); const j = buildJournal(f); const sent = await tx.select().from(accountingExport).where(and(eq(accountingExport.orgId, orgId), eq(accountingExport.locationId, v.locationId), eq(accountingExport.localDate, v.date))).orderBy(asc(accountingExport.version));
      const lines = sent.length ? delta(sent.map((s) => s.lines as Line[]), j.lines) : j.lines; if (!lines.length) return { status: "unchanged" as const, version: sent.length };
      const codes = await this.codes(orgId); const missing = [...new Set(lines.map((x) => x.account))].filter((k) => !codes.get(k)); if (missing.length) throw new ConflictException({ code: "mapping_missing", accounts: missing });
      const version = sent.length + 1; const ref = reference(l.code, v.date, version); const out = lines.map((x) => ({ code: codes.get(x.account)!.code, name: codes.get(x.account)!.name, description: x.description, amountMinor: x.amountMinor }));
      let externalRef: string | null = null; const narration = `${ref} ${l.name} end of day${version > 1 ? " (adjustment)" : ""}`;
      if (v.method === "xero") externalRef = await this.sendToXero(orgId, { narration, date: v.date, lines: out.map((x) => ({ code: x.code, description: x.description, amount: major(x.amountMinor) })), key: `${ref}:${checksum(lines)}` }, fetchFn);
      const [row] = await tx.insert(accountingExport).values({ orgId, locationId: v.locationId, localDate: v.date, version, method: v.method, lines: lines as never, reference: ref, externalRef, exportedBy: actorId }).returning();
      await this.audit.record({ orgId, actorId, action: "accounting.export", subjectType: "accounting_export", subjectId: row!.id, after: { reference: ref, method: v.method, version, lines: lines.length }, ip }, tx);
      return { status: "exported" as const, version, reference: ref, externalRef, id: row!.id, csv: v.method === "csv" ? xeroCsv({ narration, date: v.date, lines: out }) : undefined };
    });
  }
  /** The file for a version already recorded (so a download can be repeated without sending anything new). */
  async csvFor(orgId: string, id: string) {
    const [e] = await this.db.select({ e: accountingExport, code: location.code, name: location.name }).from(accountingExport).innerJoin(location, eq(location.id, accountingExport.locationId)).where(and(eq(accountingExport.id, id), eq(accountingExport.orgId, orgId))); if (!e) throw new NotFoundException({ code: "export_not_found" });
    const codes = await this.codes(orgId); return { name: `${e.e.reference}.csv`, csv: xeroCsv({ narration: `${e.e.reference} ${e.name} end of day`, date: String(e.e.localDate), lines: (e.e.lines as Line[]).map((x) => ({ code: codes.get(x.account)?.code ?? "?", name: codes.get(x.account)?.name, description: x.description, amountMinor: x.amountMinor })) }) };
  }

  // ------------------------------------------------------------ Xero
  async xeroStatus(orgId: string) { const [c] = await this.db.select().from(xeroConnection).where(eq(xeroConnection.orgId, orgId)); return c ? { connected: c.status === "active" && !!c.accessTokenEnc, tenantId: c.tenantId, clientId: c.clientId, expiresAt: c.expiresAt, lastError: c.lastError } : { connected: false }; }
  async connectXero(orgId: string, actorId: string, v: { tenantId: string; accessToken: string; refreshToken: string; clientId: string; clientSecret: string }, ip: string | null, fetchFn?: typeof fetch) {
    const probe = new XeroClient({ base: this.cfg.xeroApiBase, accessToken: v.accessToken, tenantId: v.tenantId, fetchFn }); let tenants: { id: string }[];
    try { tenants = await probe.tenants(); } catch (e) { throw new ConflictException({ code: e instanceof XeroError && e.status === 401 ? "xero_token_refused" : "xero_unreachable" }); }
    if (!tenants.some((t) => t.id === v.tenantId)) throw new ConflictException({ code: "xero_tenant_not_found" });
    const key = this.cfg.encryptionKey; const row = { tenantId: v.tenantId, accessTokenEnc: encrypt(v.accessToken, key), refreshTokenEnc: encrypt(v.refreshToken, key), clientId: v.clientId, clientSecretEnc: encrypt(v.clientSecret, key), expiresAt: new Date(Date.now() + 25 * 60_000), status: "active", lastError: null };
    await this.db.transaction(async (tx) => { await tx.insert(xeroConnection).values({ orgId, ...row }).onConflictDoUpdate({ target: xeroConnection.orgId, set: row }); await this.audit.record({ orgId, actorId, action: "xero.connect", subjectType: "org", subjectId: orgId, after: { tenantId: v.tenantId }, ip }, tx); }); return this.xeroStatus(orgId);
  }
  async disconnectXero(orgId: string, actorId: string, ip: string | null) { await this.db.update(xeroConnection).set({ status: "disconnected", accessTokenEnc: null, refreshTokenEnc: null, clientSecretEnc: null }).where(eq(xeroConnection.orgId, orgId)); await this.audit.record({ orgId, actorId, action: "xero.disconnect", subjectType: "org", subjectId: orgId, ip }); return this.xeroStatus(orgId); }
  private async sendToXero(orgId: string, j: { narration: string; date: string; lines: { code: string; description: string; amount: string }[]; key: string }, fetchFn?: typeof fetch) {
    const [c] = await this.db.select().from(xeroConnection).where(eq(xeroConnection.orgId, orgId)); if (!c || c.status !== "active" || !c.accessTokenEnc || !c.refreshTokenEnc || !c.clientSecretEnc) throw new ConflictException({ code: "xero_not_connected" });
    const key = this.cfg.encryptionKey; let access = decrypt(c.accessTokenEnc, key);
    try {
      if (!c.expiresAt || c.expiresAt.getTime() - Date.now() < 60_000) {                                         // the access token is about to end: renew it, and keep the new refresh token, because Xero retires the old one
        const t = await refreshTokens({ tokenUrl: this.cfg.xeroTokenUrl, clientId: c.clientId, clientSecret: decrypt(c.clientSecretEnc, key), refreshToken: decrypt(c.refreshTokenEnc, key), fetchFn });
        await this.db.update(xeroConnection).set({ accessTokenEnc: encrypt(t.accessToken, key), refreshTokenEnc: encrypt(t.refreshToken, key), expiresAt: new Date(Date.now() + t.expiresInSec * 1000), lastError: null }).where(eq(xeroConnection.orgId, orgId)); access = t.accessToken;
      }
      const id = await new XeroClient({ base: this.cfg.xeroApiBase, accessToken: access, tenantId: c.tenantId, fetchFn }).manualJournal(j);
      if (c.lastError) await this.db.update(xeroConnection).set({ lastError: null }).where(eq(xeroConnection.orgId, orgId)); return id;
    } catch (e) { await this.db.update(xeroConnection).set({ lastError: String(e).slice(0, 200) }).where(eq(xeroConnection.orgId, orgId)); throw new ConflictException({ code: "xero_failed", detail: String(e).slice(0, 160) }); }
  }
  async history(orgId: string) { const rows = await this.db.select({ e: accountingExport, code: location.code, name: location.name }).from(accountingExport).innerJoin(location, eq(location.id, accountingExport.locationId)).where(eq(accountingExport.orgId, orgId)).orderBy(desc(accountingExport.exportedAt)).limit(100); return rows.map(({ e, name }) => ({ id: e.id, location: name, date: String(e.localDate), version: e.version, method: e.method, reference: e.reference, externalRef: e.externalRef, exportedAt: e.exportedAt })); }
}
