import { describe, expect, it } from "vitest";
import { ScanBuffer } from "./scanner";

const feed = (b: ScanBuffer, text: string, start: number, gap: number, enter = true) => { let t = start, out: ReturnType<ScanBuffer["push"]> = { swallow: false }; for (const ch of text) { out = b.push(ch, t); t += gap; } if (enter) out = b.push("Enter", t); return out; };

describe("telling a scan from typing", () => {
  it("a fast burst ending in Enter is a scan", () => { expect(feed(new ScanBuffer(), "9300000300001", 1000, 8)).toEqual({ scan: "9300000300001", swallow: true }); });
  it("a person typing at 200 ms a key is not", () => { expect(feed(new ScanBuffer(), "9300000300001", 1000, 200)).toEqual({ swallow: false }); });
  it("a pause in the middle starts over, so slow typing before a scan does not leak into it", () => {
    const b = new ScanBuffer(); feed(b, "ab", 1000, 300, false); expect(feed(b, "9300000300002", 5000, 10).scan).toBe("9300000300002");
  });
  it("short bursts are ignored: Enter after one or two fast keys is just Enter", () => { expect(feed(new ScanBuffer(), "ab", 0, 5)).toEqual({ swallow: false }); expect(new ScanBuffer().push("Enter", 0)).toEqual({ swallow: false }); });
  it("two scans in a row are two scans, and the buffer is empty after each", () => { const b = new ScanBuffer(); expect(feed(b, "1111111", 0, 5).scan).toBe("1111111"); expect(feed(b, "2222222", 100, 5).scan).toBe("2222222"); expect(b.active).toBe(false); });
  it("keys that are not characters do not break a burst or join it", () => { const b = new ScanBuffer(); b.push("1", 0); b.push("Shift", 3); b.push("2", 6); b.push("3", 9); b.push("4", 12); expect(b.push("Enter", 15).scan).toBe("1234"); });
  it("knows when a burst is in progress", () => { const b = new ScanBuffer(); b.push("9", 0); expect(b.active).toBe(false); b.push("3", 5); expect(b.active).toBe(true); });
});
