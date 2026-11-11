import type { PullResponse, PushRequest, PushResponse, SnapshotResponse } from "@shelfline/contracts";
import { AuthError, NetworkError, ProtocolError, type StatusResponse, type Transport } from "./types";

export class HttpTransport implements Transport {
  constructor(private baseUrl: string, private token: () => string, private fetchImpl: typeof fetch = (input, init) => fetch(input, init),   // not `fetch` itself: calling it as a method of this object throws "Illegal invocation" in browsers
     private timeoutMs = 15_000) {}
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.token()}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) { throw new NetworkError(String(e)); }
    if (res.status === 401 || res.status === 403) throw new AuthError(res.status);
    if (res.status >= 500) throw new NetworkError(`server ${res.status}`);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ProtocolError(res.status, json);
    return json as T;
  }
  push(req: PushRequest) { return this.call<PushResponse>("POST", "/sync/push", req); }
  pull(cursor: string, limit?: number) { return this.call<PullResponse>("GET", `/sync/pull?cursor=${encodeURIComponent(cursor)}${limit ? `&limit=${limit}` : ""}`); }
  snapshot(after: string | null) { return this.call<SnapshotResponse>("GET", `/sync/snapshot${after ? `?after=${encodeURIComponent(after)}` : ""}`); }
  status() { return this.call<StatusResponse>("GET", "/sync/status"); }
}
