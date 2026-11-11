export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8200";
export class ApiError extends Error { constructor(public status: number, public code: string, public body: any) { super(`${status} ${code}`); this.name = "ApiError"; } }
let token: string | null = null; let onUnauthorized: () => void = () => undefined;
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;
export const setOnUnauthorized = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(path: string, o: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(`${API_URL}${path}`, { method: o.method ?? "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.body !== undefined ? { "content-type": o.body instanceof Blob || typeof o.body === "string" ? "text/csv" : "application/json" } : {}) }, body: o.body === undefined ? undefined : typeof o.body === "string" || o.body instanceof Blob ? (o.body as string | Blob) : JSON.stringify(o.body) }); }
  catch { throw new ApiError(0, "network", null); }
  if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized();
  if (o.raw) { if (!res.ok) throw new ApiError(res.status, "http", null); return (await res.text()) as T; }
  const text = await res.text(); const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, body?.code ?? `http_${res.status}`, body);
  return body as T;
}
export const qs = (o: Record<string, string | number | undefined | null | false>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== false && v !== "") p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ""; };
