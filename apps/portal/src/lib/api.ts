export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8200";
export class ApiError extends Error { constructor(public status: number, public code: string, public body: any) { super(`${status} ${code}`); this.name = "ApiError"; } }
const KEY = "shelfline-portal-token";
let token: string | null = null; try { token = sessionStorage.getItem(KEY); } catch { /* private window */ }
let onUnauthorized: () => void = () => undefined;
export const setOnUnauthorized = (f: () => void) => { onUnauthorized = f; };
export const hasToken = () => token !== null;
export const setToken = (t: string | null) => { token = t; try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } };

export async function api<T = any>(path: string, o: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(`${API_URL}${path}`, { method: o.method ?? "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }); }
  catch { throw new ApiError(0, "network", null); }
  if (res.status === 401 && token && !path.startsWith("/portal/auth/")) { setToken(null); onUnauthorized(); }
  if (o.raw && res.ok) return (await res.text()) as T;
  const text = await res.text(); const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, body?.code ?? `http_${res.status}`, body);
  return body as T;
}
export const qs = (o: Record<string, string | undefined | null>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ""; };

const f = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const plain = (minor: number) => (minor < 0 ? "−" : "") + f.format(Math.abs(minor) / 100);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return `${d} ${MONTHS[m! - 1]} ${y}`; };
export const range = (a: string, b: string) => (a === b ? day(a) : `${day(a)} – ${day(b)}`);
