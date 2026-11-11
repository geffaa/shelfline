import { describe, expect, it } from "vitest";
import { zonedInstant } from "../common/business-day";
import { checksumOf, dueDays, renderCsv, renderLines, subjectOf, totalsOf, type Figures, type LocationFigures } from "./figures";
import { textPdf } from "./pdf";

const loc = (o: Partial<LocationFigures> = {}): LocationFigures => ({ id: "l", name: "Fitzroy", orders: 2, grossMinor: 30000, discountMinor: 500, refundsMinor: 1000, netMinor: 29000, taxMinor: 2636, tenders: { card: 20000, cash: 10000 }, noSales: 1, sessionsClosed: 1, sessionsOpen: 0, varianceMinor: -500, ...o });
const fig = (ls = [loc()], date = "2030-06-15"): Figures => ({ localDate: date, locations: ls, totals: totalsOf(ls) });
const PER = "Australia/Perth", MEL = "Australia/Melbourne";
const at = (date: string, hm: string, tz: string) => new Date(zonedInstant(date, hm, tz));

describe("when a schedule is due, in its own time zone", () => {
  const sc = (o: object = {}) => ({ sendAtLocal: "21:30", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timezone: PER, cutoff: "04:00", ...o });
  it("21:30 in Perth is 13:30 UTC, and not a minute earlier", () => {
    expect(dueDays(sc(), new Date("2030-06-15T13:29:00Z")).map((d) => d.runAt.toISOString())).toEqual(["2030-06-14T13:30:00.000Z"]);        // only yesterday's has passed
    const d = dueDays(sc(), new Date("2030-06-15T13:30:00Z")); expect(d.map((x) => x.runAt.toISOString())).toEqual(["2030-06-14T13:30:00.000Z", "2030-06-15T13:30:00.000Z"]); expect(d[1]!.reportDate).toBe("2030-06-15");
  });
  it("Melbourne keeps 21:30 on the wall clock through both clock changes, so the UTC instant moves", () => {
    expect(at("2027-04-03", "21:30", MEL).toISOString()).toBe("2027-04-03T10:30:00.000Z");          // still daylight time
    expect(at("2027-04-04", "21:30", MEL).toISOString()).toBe("2027-04-04T11:30:00.000Z");          // the clocks went back that morning
    expect(at("2027-10-02", "21:30", MEL).toISOString()).toBe("2027-10-02T11:30:00.000Z");
    expect(at("2027-10-03", "21:30", MEL).toISOString()).toBe("2027-10-03T10:30:00.000Z");          // forward that morning
    expect(dueDays(sc({ timezone: MEL }), new Date("2027-04-04T11:29:00Z")).map((d) => d.reportDate)).toEqual(["2027-04-03"]);
    expect(dueDays(sc({ timezone: MEL }), new Date("2027-04-04T11:30:00Z")).map((d) => d.reportDate)).toEqual(["2027-04-03", "2027-04-04"]);
  });
  it("only the chosen weekdays, and a send time before the day cutoff reports on the day before", () => {
    const mon = new Date("2030-06-17T13:30:00Z");                                                       // Monday evening in Perth
    expect(dueDays(sc({ daysOfWeek: [1] }), mon).map((d) => d.reportDate)).toEqual(["2030-06-17"]); expect(dueDays(sc({ daysOfWeek: [2] }), mon)).toEqual([]);
    const early = dueDays(sc({ sendAtLocal: "02:00", timezone: MEL }), new Date("2030-06-16T16:30:00Z"));      // 02:30 Monday AEST
    expect(early.at(-1)!.reportDate).toBe("2030-06-16");      // 02:00 Monday is still Sunday's trading day
    expect(early.at(-1)!.runAt.toISOString()).toBe("2030-06-16T16:00:00.000Z");
  });
});

describe("what makes two reports the same", () => {
  it("only their figures: any change in a number changes the checksum, nothing else does", () => {
    const a = fig(); expect(checksumOf(a)).toBe(checksumOf(fig())); expect(checksumOf(a)).not.toBe(checksumOf(fig([loc({ orders: 3 })]))); expect(checksumOf(a)).not.toBe(checksumOf(fig([loc({ varianceMinor: -600 })]))); expect(checksumOf(a)).not.toBe(checksumOf(fig([loc({ sessionsOpen: 1 })])));
    expect(checksumOf(a)).not.toBe(checksumOf(fig([loc({ tenders: { card: 20000, cash: 10001 } })])));
  });
  it("totals add the places up exactly, including each way of paying", () => {
    const t = totalsOf([loc(), loc({ id: "m", name: "Melb", orders: 5, grossMinor: 1, netMinor: 1, tenders: { gift_card: 7, card: 3 } })]); expect(t).toMatchObject({ orders: 7, grossMinor: 30001, netMinor: 29001 }); expect(t.tenders).toEqual({ card: 20003, cash: 10000, gift_card: 7 });
  });
});

describe("what is written", () => {
  it("labels provisional and amended reports in the subject and the text, and shows the notes", () => {
    expect(subjectOf("final", "Fitzroy close", "2030-06-15")).toMatch(/^End of day: Fitzroy close, Sat,? 15 June 2030$/); expect(subjectOf("provisional", "Fitzroy close", "2030-06-15")).toMatch(/^\[Provisional\] /); expect(subjectOf("amended", "x", "2030-06-15")).toMatch(/^\[Amended\] /);
    const text = renderLines("Fitzroy close", "provisional", fig(), ["Still open: Front desk at Fitzroy"], 1).join("\n"); expect(text).toContain("PROVISIONAL"); expect(text).toContain("Still open: Front desk at Fitzroy"); expect(text).toContain("Net sales"); expect(text).toContain("290.00"); expect(text).toContain("ALL LOCATIONS");
    expect(renderLines("x", "final", fig(), [], 1).join("\n")).not.toMatch(/PROVISIONAL|AMENDED/); expect(renderLines("x", "amended", fig(), [], 2).join("\n")).toContain("AMENDED");
  });
  it("the CSV has a header, a row per place and a total", () => {
    const rows = renderCsv(fig([loc(), loc({ id: "m", name: 'Melb, "CBD"' })])).trim().split("\n"); expect(rows[0]).toMatch(/^location,orders,gross/); expect(rows).toHaveLength(4); expect(rows[2]).toMatch(/^"Melb, ""CBD"""/); expect(rows[3]).toMatch(/^All locations,4,600.00/);
  });
  it("the PDF is a real PDF with the text in it, and long reports flow onto more pages", () => {
    const one = textPdf("Title (with) parens", ["line one", "line two"]).toString("latin1"); expect(one.startsWith("%PDF-1.4")).toBe(true); expect(one).toContain("(Title \\(with\\) parens) Tj"); expect(one).toContain("(line two) Tj"); expect(one).toContain("%%EOF"); expect(one).toMatch(/\/Count 1/);
    const many = textPdf("t", Array.from({ length: 120 }, (_, i) => `row ${i}`)).toString("latin1"); expect(many).toMatch(/\/Count 3/); expect(many).toContain("(Page 3 of 3) Tj");
    const xref = Number(/startxref\n(\d+)/.exec(many)![1]); expect(many.slice(xref, xref + 4)).toBe("xref");
  });
});
