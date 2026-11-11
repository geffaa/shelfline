import { describe, expect, it } from "vitest";
import { buildJournal, checksum, delta, reference, sum, xeroCsv, type DayFigures, type Line } from "./journal";

const day = (o: Partial<DayFigures> = {}): DayFigures => ({ salesTotalMinor: 43990, salesTaxMinor: 3999, roundingMinor: 0, tendersIn: { card: 30000, cash: 13990 }, refundsTotalMinor: 0, refundsTaxMinor: 0, tendersOut: {}, varianceMinor: 0, cogsMinor: 12000, cogsReturnedMinor: 0, ...o });
const by = (ls: Line[]) => Object.fromEntries(ls.map((l) => [l.account, l.amountMinor]));

describe("a day as a journal", () => {
  it("debits what was taken, credits sales without GST and the GST, and moves the cost of goods out of stock", () => {
    const { lines, unreconciledMinor } = buildJournal(day()); expect(unreconciledMinor).toBe(0); expect(by(lines)).toEqual({ cash: 13990, card_clearing: 30000, sales_revenue: -39991, gst_collected: -3999, cogs: 12000, inventory: -12000 }); expect(sum(lines)).toBe(0);
  });
  it("refunds reverse the sale, a short drawer goes to over-and-short, rounding to its own line", () => {
    const { lines } = buildJournal(day({ refundsTotalMinor: 10995, refundsTaxMinor: 1000, tendersOut: { card: 10995 }, varianceMinor: -500, roundingMinor: -5, tendersIn: { card: 30000, cash: 13985 }, salesTotalMinor: 43985, cogsReturnedMinor: 3000 }));
    expect(by(lines)).toMatchObject({ card_clearing: 30000 - 10995, sales_revenue: -((43985 - 3999) - (10995 - 1000)), gst_collected: -(3999 - 1000), rounding: 5, cash_over_short: 500, cash: 13985 - 500, cogs: 9000, inventory: -9000 }); expect(sum(lines)).toBe(0);
  });
  it("always balances: a payment that does not match the sales is put on a visible unreconciled line, not hidden", () => {
    const { lines, unreconciledMinor } = buildJournal(day({ tendersIn: { card: 30000, cash: 13000 } })); expect(unreconciledMinor).toBe(-990); expect(by(lines).suspense).toBe(990); expect(sum(lines)).toBe(0);
  });
  it("gift cards, store credit and other tenders each get their own account; an unknown tender goes to 'other'", () => {
    const { lines } = buildJournal(day({ tendersIn: { gift_card: 5000, store_credit: 2000, other: 1000, voucher: 35990 }, salesTotalMinor: 43990 })); expect(by(lines)).toMatchObject({ gift_card_liability: 5000, store_credit_liability: 2000, other_clearing: 36990 }); expect(sum(lines)).toBe(0);
  });
  it("an empty day is an empty journal; zero lines are never sent", () => { expect(buildJournal(day({ salesTotalMinor: 0, salesTaxMinor: 0, tendersIn: {}, cogsMinor: 0 })).lines).toEqual([]); });
  it("balances for any figures that are consistent, and always balances with the unreconciled line whatever is thrown at it", () => {
    let seed = 9; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; const n = () => Math.floor(rnd() * 200000);
    for (let i = 0; i < 3000; i++) { const sales = n(), tax = Math.floor(sales / 11), ref = Math.floor(rnd() * sales), rtax = Math.floor(ref / 11), rnd5 = Math.floor(rnd() * 11) - 5;
      const cash = Math.floor(rnd() * (sales + rnd5)); const f = day({ salesTotalMinor: sales, salesTaxMinor: tax, roundingMinor: rnd5, tendersIn: { cash, card: sales + rnd5 - cash }, refundsTotalMinor: ref, refundsTaxMinor: rtax, tendersOut: { card: ref }, varianceMinor: Math.floor(rnd() * 2000) - 1000, cogsMinor: n(), cogsReturnedMinor: Math.floor(rnd() * 1000) });
      const j = buildJournal(f); expect(j.unreconciledMinor).toBe(0); expect(sum(j.lines)).toBe(0); const bad = buildJournal({ ...f, tendersIn: { cash: cash + Math.floor(rnd() * 500) - 250, card: sales + rnd5 - cash } }); expect(sum(bad.lines)).toBe(0); }
  });
});

describe("sending only what is new", () => {
  const l = (account: Line["account"], amountMinor: number): Line => ({ account, amountMinor, description: account });
  it("nothing changed means nothing to send; a change is sent as the difference per account", () => {
    const v1 = buildJournal(day()).lines; expect(delta([v1], buildJournal(day()).lines)).toEqual([]); expect(delta([], v1)).toEqual(v1.filter((x) => x.amountMinor !== 0));
    const later = buildJournal(day({ refundsTotalMinor: 5000, refundsTaxMinor: 455, tendersOut: { card: 5000 } })).lines; const d = delta([v1], later); expect(by(d)).toEqual({ card_clearing: -5000, sales_revenue: 4545, gst_collected: 455 }); expect(sum(d)).toBe(0);
  });
  it("versions add up: the first plus every adjustment equals the day as it now stands", () => {
    const v1 = buildJournal(day()).lines; const s2 = day({ refundsTotalMinor: 5000, refundsTaxMinor: 455, tendersOut: { card: 5000 } }); const v2 = delta([v1], buildJournal(s2).lines); const s3 = { ...s2, varianceMinor: -300 }; const v3 = delta([v1, v2], buildJournal(s3).lines);
    expect(by([...v1, ...v2, ...v3].reduce<Line[]>((a, x) => { const e = a.find((y) => y.account === x.account); if (e) e.amountMinor += x.amountMinor; else a.push({ ...x }); return a; }, []))).toEqual(by(buildJournal(s3).lines)); expect(sum(v3)).toBe(0); expect(delta([v1, v2, v3], buildJournal(s3).lines)).toEqual([]);
  });
  it("a checksum ignores the order and the wording", () => { expect(checksum([l("cash", 5), l("cogs", 2)])).toBe(checksum([{ ...l("cogs", 2), description: "x" }, l("cash", 5)])); expect(checksum([l("cash", 5)])).not.toBe(checksum([l("cash", 6)])); });
  it("references are readable and an adjustment says so", () => { expect(reference("fit", "2026-11-04", 1)).toBe("SHELFLINE-FIT-2026-11-04"); expect(reference("fit", "2026-11-04", 3)).toBe("SHELFLINE-FIT-2026-11-04-ADJ3"); });
});

describe("the file Xero imports", () => {
  it("has the headings Xero asks for, the date in day/month/year, debits positive and credits negative, quoted text, and balances", () => {
    const csv = xeroCsv({ narration: 'Fitzroy, "close"', date: "2026-11-04", lines: [{ code: "200", description: "Sales", amountMinor: -39991 }, { code: "090", description: "Takings, cash", amountMinor: 39991 }] }).trim().split("\n");
    expect(csv[0]).toBe("*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1"); expect(csv[1]).toBe('"Fitzroy, ""close""",04/11/2026,Sales,200,Tax Exempt,-399.91,,'); expect(csv[2]).toContain('"Takings, cash"'); expect(csv[2]).toContain(",399.91,");
  });
});
