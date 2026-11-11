import { createHash } from "node:crypto";

/** The two Xero calls the export needs, and the token renewal Xero's short-lived tokens force. Written from Xero's public documentation and exercised against a stand-in; it has not been run against Xero (V16). */
export class XeroError extends Error { constructor(public status: number, message: string) { super(message); this.name = "XeroError"; } }
export interface Tokens { accessToken: string; refreshToken: string; expiresInSec: number }
export async function refreshTokens(o: { tokenUrl: string; clientId: string; clientSecret: string; refreshToken: string; fetchFn?: typeof fetch }): Promise<Tokens> {
  const res = await (o.fetchFn ?? fetch)(o.tokenUrl, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refreshToken }).toString(), signal: AbortSignal.timeout(15_000) });
  const b = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !b.access_token || !b.refresh_token) throw new XeroError(res.status, `xero token ${res.status}: ${b.error ?? "refused"}`);
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresInSec: b.expires_in ?? 1800 };
}
export class XeroClient {
  constructor(private o: { base: string; accessToken: string; tenantId: string; fetchFn?: typeof fetch }) {}
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, idem?: string): Promise<T> {
    const res = await (this.o.fetchFn ?? fetch)(`${this.o.base}${path}`, { method, headers: { authorization: `Bearer ${this.o.accessToken}`, "xero-tenant-id": this.o.tenantId, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(idem ? { "idempotency-key": idem } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const text = await res.text(); let data: unknown = {}; try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) throw new XeroError(res.status, `xero ${res.status}: ${text.slice(0, 160)}`); return data as T;
  }
  /** The organisations this token can act for. */
  async tenants() { return (await this.call<{ tenantId: string; tenantName?: string }[]>("GET", "/connections")).map((t) => ({ id: t.tenantId, name: t.tenantName ?? "" })); }
  /** A DRAFT manual journal: an accountant looks at it and posts it. The lines must add to zero; Xero checks too. The idempotency key makes a retry of the same journal harmless. */
  async manualJournal(j: { narration: string; date: string; lines: { code: string; description: string; amount: string }[]; key: string }) {
    const r = await this.call<{ ManualJournals?: { ManualJournalID?: string }[] }>("POST", "/api.xro/2.0/ManualJournals", { ManualJournals: [{ Narration: j.narration, Date: j.date, Status: "DRAFT", LineAmountTypes: "NoTax", JournalLines: j.lines.map((l) => ({ LineAmount: Number(l.amount), AccountCode: l.code, Description: l.description })) }] }, createHash("sha256").update(j.key).digest("hex"));
    const id = r.ManualJournals?.[0]?.ManualJournalID; if (!id) throw new XeroError(502, "xero answered without a journal id"); return id;
  }
}
