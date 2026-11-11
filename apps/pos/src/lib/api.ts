import type { AuthState } from "../state/config";

export class ApiError extends Error { constructor(public status: number, public code: string, public body: unknown) { super(code); this.name = "ApiError"; } }
export class OfflineError extends Error { constructor() { super("offline"); this.name = "OfflineError"; } }

async function call<T>(base: string, path: string, init: RequestInit & { token?: string; deviceKey?: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.deviceKey ? { "x-device-key": init.deviceKey } : {}) }, signal: AbortSignal.timeout(10_000) });
  } catch { throw new OfflineError(); }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, (body as { code?: string } | undefined)?.code ?? `http_${res.status}`, body);
  return body as T;
}

export async function signIn(base: string, deviceKey: string, employeeCode: string, pin: string): Promise<AuthState> {
  const r = await call<{ token: string; expiresInSec: number; locationId: string; registerId: string | null }>(base, "/pos/pin", { method: "POST", deviceKey, body: JSON.stringify({ employeeCode, pin }) });
  const me = await call<{ user: { id: string; name: string }; assignments: { permissions: string[]; locationId: string | null }[] }>(base, "/auth/me", { method: "GET", token: r.token });
  const canApprove = me.assignments.some((a) => (a.locationId === null || a.locationId === r.locationId) && a.permissions.includes("sale:approve_discount"));
  return { token: r.token, expiresAt: Date.now() + r.expiresInSec * 1000, userId: me.user.id, name: me.user.name, employeeCode, locationId: r.locationId, registerId: r.registerId, canApprove };
}

/** A manager's PIN approves one discount. Needs the network on purpose: the till holds no PIN hashes. */
export function requestApproval(base: string, token: string, deviceKey: string, managerEmployeeCode: string, pin: string, kind: "discount" | "variance" | "refund" = "discount") {
  return call<{ approvalToken: string; approver: { id: string; name: string } }>(base, "/pos/approve", { method: "POST", token, deviceKey, body: JSON.stringify({ managerEmployeeCode, pin, kind }) });
}

export interface ServerSale { id: string; receiptNo: string; at: string; cashierName: string; customerName: string | null; totalMinor: number; sessionId: string | null; lines: { lineNo: number; variantId: string; title: string; optionsLabel: string; qty: number; refundedQty: number; totalMinor: number; refundedMinor: number; taxMinor: number; refundedTaxMinor: number }[]; payments: { tender: string; amountMinor: number }[] }
export const lookupSales = (base: string, token: string, receipt: string) => call<ServerSale[]>(base, `/pos/sales${receipt ? `?receipt=${encodeURIComponent(receipt)}` : ""}`, { method: "GET", token });
export interface ServerSession { id: string; status: string; expectedMinor: number | null; countedMinor: number | null; varianceMinor: number | null; flags: string[]; z: { expectedMinor: number; grossSalesMinor: number; refundsMinor: number; netSalesMinor: number; gstMinor: number; salesCount: number; noSaleCount: number; tenders: { cashMinor: number; cardMinor: number; otherMinor: number }; cash: { salesMinor: number; refundsMinor: number; payInMinor: number; payOutMinor: number; dropMinor: number; floatAddMinor: number } } | null }
export const getSession = (base: string, token: string, id: string) => call<ServerSession>(base, `/pos/sessions/${id}`, { method: "GET", token });

/** Plain authenticated JSON call for the handheld stock screens (receive a transfer, count). These need the network: they act on the server's ledger directly. */
export const apiCall = <T,>(base: string, token: string, path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown) => call<T>(base, path, { method, token, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Asks the server to print at this register's printer, or to open the drawer. Needs the network: the printer is reached through the store's bridge. */
export type PrintAnswer = { jobId: string; printer: string; copy?: number };
export const requestPrint = (base: string, token: string, body: { kind: "receipt"; saleId: string } | { kind: "drawer"; reason: "cash_sale" | "no_sale" | "manual" }) => call<PrintAnswer>(base, "/pos/print", { method: "POST", token, body: JSON.stringify(body) });
/** What to tell the cashier when a print request did not go through. */
export function printProblem(e: unknown): string {
  if (e instanceof OfflineError) return "Printing needs a connection. Try again when the till is back online.";
  if (e instanceof ApiError) return e.code === "no_printer" ? "No printer is set up for this register. Ask a manager to add one in the back office." : e.status === 404 ? "That sale has not reached the server yet. Try again in a moment." : "The printer could not be reached.";
  return "The printer could not be reached.";
}

export interface PickupOrder { id: string; number: string; status: "placed" | "ready"; customer: string; totalMinor: number; expiresAt: string; lines: { variantId: string; title: string; options: string; qty: number; unitPriceMinor: number; totalMinor: number }[] }
export const lookupPickup = (base: string, token: string, code: string) => call<PickupOrder>(base, `/pos/online-orders/lookup?code=${encodeURIComponent(code.trim())}`, { method: "GET", token });
