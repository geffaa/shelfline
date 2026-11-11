import { API_URL, getToken } from "./api";
export type LiveState = "connecting" | "live" | "offline";
export interface ChangeEvent { kind: string; locationId: string | null; id: string }

/** Server-sent events over fetch (so the Authorization header can be sent). Reconnects with backoff; every notice is just ids: the screen refetches. */
export function startLive(onEvent: (e: ChangeEvent) => void, onState: (s: LiveState) => void): () => void {
  let stopped = false; let ctrl: AbortController | null = null; let attempt = 0;
  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController(); onState("connecting");
      try {
        const res = await fetch(`${API_URL}/stream`, { headers: { authorization: `Bearer ${getToken() ?? ""}`, accept: "text/event-stream" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onState("live"); attempt = 0;
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
          let i: number; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const type = /^event: (.*)$/m.exec(blk)?.[1]; const data = /^data: (.*)$/m.exec(blk)?.[1]; if (type === "change" && data) { try { onEvent(JSON.parse(data) as ChangeEvent); } catch { /* ignore */ } } }
        }
      } catch { if (stopped) return; }
      onState("offline"); attempt++; await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))));
    }
  };
  void run(); return () => { stopped = true; ctrl?.abort(); };
}
