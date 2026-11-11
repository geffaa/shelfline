import { describe, expect, it } from "vitest";
import { decodeEscPos, EscPos, toCp437 } from "./escpos";
import { drawerBytes, pair, renderReceipt, testPage, wrap, type ReceiptData } from "./receipt";

const sale = (o: Partial<ReceiptData> = {}): ReceiptData => ({ org: "Kestrel Run Co.", location: "Fitzroy", register: "FIT-1", receiptNo: "FIT-1-000123", at: "Wed 4 Nov 2026 14:05", cashier: "Priya N.", copy: 1, columns: 42,
  lines: [{ title: "Tempra Glide 3", options: "10.5 · Black/White", qty: 1, unitMinor: 21995, discountMinor: 0, totalMinor: 21995 }, { title: "Merino running tee with a rather long name that must wrap", qty: 2, unitMinor: 8900, discountMinor: 890, totalMinor: 16910 }],
  subtotalMinor: 39795, discountMinor: 890, taxMinor: 3536, totalMinor: 38905, roundingMinor: 0, payments: [{ tender: "cash", amountMinor: 40000, changeMinor: 1095 }], footer: "Thank you. Returns within 30 days with this receipt.", ...o });

describe("ESC/POS bytes", () => {
  it("writes the documented command bytes", () => {
    expect(Array.from(new EscPos().init().align("center").bold(true).big(true).text("Hi").feed().cut().bytes())).toEqual([0x1b, 0x40, 0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
    expect(Array.from(drawerBytes())).toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(Array.from(new EscPos().barcode("A1").bytes())).toEqual([0x1d, 0x48, 2, 0x1d, 0x68, 60, 0x1d, 0x77, 2, 0x1d, 0x6b, 73, 4, 0x7b, 0x42, 0x41, 0x31]);
  });
  it("maps text to CP437 and never fails on characters the printer lacks", () => {
    expect(toCp437("café")).toEqual([0x63, 0x61, 0x66, 0x82]); expect(toCp437("naïve señor")).toContain(0x8b); expect(toCp437("“quoted” — dash…")).toEqual(Array.from('"quoted" - dash...').map((c) => c.charCodeAt(0)));
    expect(toCp437("日本")).toEqual([0x3f, 0x3f]); expect(toCp437("€5")).toEqual(Array.from("EUR5").map((c) => c.charCodeAt(0)));
  });
  it("the reader recovers what the writer wrote, including cuts, kicks, barcodes and bold", () => {
    const d = decodeEscPos(new EscPos().init().bold(true).line("TOTAL").bold(false).line("plain").barcode("FIT-1-1").drawer().feedLines(2).cut().bytes());
    expect(d.lines).toEqual(["TOTAL", "plain"]); expect(d.bold).toEqual(["TOTAL"]); expect(d.barcodes).toEqual(["FIT-1-1"]); expect(d).toMatchObject({ cuts: 1, drawerKicks: 1, unknown: 0 });
  });
});

describe("the receipt", () => {
  const text = (r: ReceiptData) => decodeEscPos(renderReceipt(r)).lines;
  it("fits the paper: no line is wider than the columns, on 80 mm and on 58 mm paper", () => {
    for (const columns of [42, 32, 48]) for (const l of text(sale({ columns }))) expect([columns, l.length <= columns]).toEqual([columns, true]);
  });
  it("lists the items, the discount, the total, the payment and the change, with figures lined up on the right", () => {
    const t = text(sale()); const body = t.join("\n"); expect(body).toContain("Kestrel Run"); expect(body).toContain("Served by Priya N."); expect(body).toContain("10.5");
    expect(t.find((l) => l.includes("1 x Tempra Glide 3"))).toMatch(/219\.95$/); expect(t.find((l) => l.includes("Discount"))).toMatch(/-8\.90$/); expect(t.find((l) => l.startsWith("Subtotal"))).toMatch(/397\.95$/); expect(t.find((l) => l.startsWith("GST included"))).toMatch(/35\.36$/);
    expect(t.find((l) => l.startsWith("Cash"))).toMatch(/400\.00$/); expect(t.find((l) => l.includes("Change"))).toMatch(/10\.95$/); expect(body).toContain("TOTAL"); expect(body).toContain("389.05");
    for (const l of t) if (/\d\.\d\d$/.test(l) && l.length > 20) expect(l.length).toBeLessThanOrEqual(42);
  });
  it("wraps a long item name instead of cutting the price, and prints the receipt number as text and as a barcode", () => {
    const t = text(sale()); const i = t.findIndex((l) => l.includes("2 x Merino")); expect(t[i]).toMatch(/178\.00$/); expect(t[i + 1]).toMatch(/^ {4}\S/); expect(t.join("\n")).toContain("Receipt FIT-1-000123");
    expect(decodeEscPos(renderReceipt(sale())).barcodes).toEqual(["FIT-1-000123"]); expect(decodeEscPos(renderReceipt(sale())).cuts).toBe(1);
  });
  it("is the same bytes every time, and a reprint says COPY so it cannot pass for the original", () => {
    expect(Array.from(renderReceipt(sale()))).toEqual(Array.from(renderReceipt(sale()))); expect(text(sale()).join("\n")).not.toContain("COPY"); expect(text(sale({ copy: 2 })).join("\n")).toContain("*** COPY 2 ***");
  });
  it("shows rounding and card references only when there are some", () => {
    expect(text(sale()).join("\n")).not.toContain("Rounding"); const t = text(sale({ roundingMinor: -5, payments: [{ tender: "card", amountMinor: 38900, changeMinor: 0, reference: "TERM 0042" }] })).join("\n"); expect(t).toContain("Rounding"); expect(t).toContain("Card TERM 0042");
  });
  it("pair and wrap behave at the edges", () => {
    expect(pair("a", "1.00", 10)).toBe("a     1.00"); expect(pair("a very long label here", "1.00", 12)).toMatch(/^a very +1\.00$/); expect(pair("a very long label here", "1.00", 12).length).toBe(12);
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]); expect(wrap("x".repeat(30), 10)).toEqual(["xxxxxxxxxx"]); expect(wrap("", 10)).toEqual([""]);
  });
  it("a test page prints a ruler of the right width", () => { const t = decodeEscPos(testPage("Front desk", 42)).lines; expect(t.some((l) => l === "0123456789".repeat(5).slice(0, 42))).toBe(true); expect(t.join("\n")).toContain("café".replace("é", "é")); });
});
