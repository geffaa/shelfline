import { afterEach, describe, expect, it, vi } from "vitest";
import { startLive, type ChangeEvent, type LiveState } from "./live";
import { setToken } from "./api";

const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); } });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("live stream client", () => {
  it("parses change events even when they are split across network chunks; ignores pings; sends the bearer token", async () => {
    setToken("tok-123"); const seen: ChangeEvent[] = []; const states: LiveState[] = [];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream(["event: ping\ndata: {}\n\nevent: cha", 'nge\ndata: {"kind":"sale","locationId":"L1","id":"s1"}\n\n', 'event: change\ndata: {"kind":"refund","loc']) });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startLive((e) => seen.push(e), (s) => states.push(s));
    await vi.waitFor(() => expect(seen).toHaveLength(1)); stop();
    expect(seen[0]).toEqual({ kind: "sale", locationId: "L1", id: "s1" });
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer tok-123"); expect(states).toContain("live");
  });
  it("reports offline and retries after a failure, then goes live again", async () => {
    vi.useFakeTimers(); setToken("t"); const states: LiveState[] = [];
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ok: true, status: 200, body: stream([]) });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startLive(() => undefined, (s) => states.push(s));
    await vi.advanceTimersByTimeAsync(50); expect(states).toContain("offline");
    await vi.advanceTimersByTimeAsync(2000); expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); expect(states).toContain("live"); stop();
  });
  it("a 401 or 403 is treated as offline (not an event), and stopping ends the loop", async () => {
    vi.useFakeTimers(); setToken("t"); const states: LiveState[] = []; vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, body: null }));
    const stop = startLive(() => undefined, (s) => states.push(s)); await vi.advanceTimersByTimeAsync(100); expect(states).toContain("offline"); stop();
    const n = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
  });
});
