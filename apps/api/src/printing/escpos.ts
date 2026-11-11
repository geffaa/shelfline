/** A small ESC/POS writer and reader: the part of the printer language a receipt needs. The reader exists so the virtual printer and the tests can see what a real printer would print. */
export const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// CP437 has the box and accent characters shops need; anything it lacks becomes "?" so a print never fails on a curly quote.
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const FOLD: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "€": "EUR", "•": "*", " ": " " };
export function toCp437(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.replace(/[‘’“”–—…€• ]/g, (c) => FOLD[c]!)) {
    const cp = ch.codePointAt(0)!; if (cp >= 0x20 && cp < 0x7f) { out.push(cp); continue; }
    const i = CP437_HIGH.indexOf(ch); out.push(i >= 0 ? 0x80 + i : 0x3f);
  }
  return out;
}
export const fromCp437 = (bytes: number[]) => bytes.map((b) => (b >= 0x80 ? CP437_HIGH[b - 0x80]! : String.fromCharCode(b))).join("");

export class EscPos {
  private b: number[] = [];
  init() { this.b.push(ESC, 0x40); return this; }
  align(a: "left" | "center" | "right") { this.b.push(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); return this; }
  bold(on: boolean) { this.b.push(ESC, 0x45, on ? 1 : 0); return this; }
  big(on: boolean) { this.b.push(GS, 0x21, on ? 0x11 : 0x00); return this; }
  text(s: string) { this.b.push(...toCp437(s)); return this; }
  line(s = "") { return this.text(s).feed(); }
  feed() { this.b.push(LF); return this; }
  feedLines(n: number) { this.b.push(ESC, 0x64, n); return this; }
  /** Code 128 (set B) under the receipt, with the digits printed below it. */
  barcode(data: string) { const d = [...toCp437("{B" + data)]; this.b.push(GS, 0x48, 2, GS, 0x68, 60, GS, 0x77, 2, GS, 0x6b, 73, d.length, ...d); return this; }
  cut() { this.b.push(GS, 0x56, 0x42, 0x00); return this; }                 // feed to the cutter and cut partway
  /** Pulse pin 2 (the usual cash drawer connection) for 50 ms on, 500 ms off. */
  drawer() { this.b.push(ESC, 0x70, 0x00, 0x19, 0xfa); return this; }
  bytes() { return Uint8Array.from(this.b); }
}

export interface Decoded { lines: string[]; cuts: number; drawerKicks: number; barcodes: string[]; bold: string[]; unknown: number }
/** Reads what the writer wrote (and the common commands a till sends). Unknown commands are counted, not guessed at. */
export function decodeEscPos(bytes: Uint8Array | number[]): Decoded {
  const d: Decoded = { lines: [], cuts: 0, drawerKicks: 0, barcodes: [], bold: [], unknown: 0 }; let cur: number[] = []; let bold = false; let lineBold = false;
  const flush = () => { const t = fromCp437(cur); d.lines.push(t); if (lineBold && t.trim()) d.bold.push(t.trim()); cur = []; lineBold = false; };
  const a = Array.from(bytes);
  for (let i = 0; i < a.length; i++) {
    const c = a[i]!;
    if (c === LF) { flush(); continue; }
    if (c === ESC) {
      const n = a[++i]!;
      if (n === 0x40) { bold = false; continue; } if (n === 0x61 || n === 0x64 || n === 0x4d || n === 0x32) { i++; continue; } if (n === 0x45) { bold = a[++i] === 1; continue; }
      if (n === 0x70) { i += 3; d.drawerKicks++; continue; } d.unknown++; continue;
    }
    if (c === GS) {
      const n = a[++i]!;
      if (n === 0x56) { i += a[i + 1] === 0x42 || a[i + 1] === 0x41 ? 2 : 1; d.cuts++; continue; }                 // GS V m [n]
      if (n === 0x21 || n === 0x48 || n === 0x68 || n === 0x77) { i++; continue; }
      if (n === 0x6b) { const m = a[++i]!; if (m >= 65) { const len = a[++i]!; d.barcodes.push(fromCp437(a.slice(i + 1, i + 1 + len)).replace(/^\{[ABC]/, "")); i += len; } else d.unknown++; continue; }
      d.unknown++; continue;
    }
    if (c >= 0x20) { cur.push(c); if (bold) lineBold = true; } else d.unknown++;
  }
  if (cur.length) flush(); return d;
}
