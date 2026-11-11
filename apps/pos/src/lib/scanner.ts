/**
 * A Bluetooth or USB barcode scanner behaves like a keyboard that types very fast and ends with Enter. This tells scans from typing by their speed:
 * a burst of characters, each within `gapMs` of the last, ending in Enter, and at least `minLength` long.
 */
export class ScanBuffer {
  private chars = ""; private last = 0;
  constructor(private o: { gapMs?: number; minLength?: number } = {}) {}
  /** Feed every key press. Returns the code when Enter closes a burst that looks like a scan. */
  push(key: string, at: number): { scan?: string; swallow: boolean } {
    const gap = this.o.gapMs ?? 50, min = this.o.minLength ?? 4;
    if (this.chars && at - this.last > gap) this.chars = "";                          // too slow to be a scanner: it was a person typing
    if (key === "Enter") { const code = this.chars; this.chars = ""; return code.length >= min ? { scan: code, swallow: true } : { swallow: false }; }
    if (key.length === 1) { this.chars += key; this.last = at; return { swallow: false }; }
    return { swallow: false };
  }
  /** True while a burst is in progress, so the page can keep the characters out of whatever field has focus. */
  get active() { return this.chars.length >= 2; }
}
