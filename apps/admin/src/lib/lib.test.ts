import { describe, expect, it } from "vitest";
import { addDays, ago, flagLabel, money, plain, todayYmd } from "./format";
import { parse, href } from "../router";
import { qs } from "./api";

describe("format", () => {
  it("money and plain show minor units exactly, with a real minus sign", () => { expect(money(36805)).toBe("A$368.05"); expect(money(null)).toBe("—"); expect(plain(-1000)).toBe("−10.00"); expect(plain(123456789)).toBe("1,234,567.89"); expect(plain(0)).toBe("0.00"); });
  it("addDays crosses month and year boundaries and leap days", () => { expect(addDays("2026-11-30", 1)).toBe("2026-12-01"); expect(addDays("2026-01-01", -1)).toBe("2025-12-31"); expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); expect(addDays("2027-02-28", 1)).toBe("2027-03-01"); });
  it("todayYmd formats the local date with zero padding", () => { expect(todayYmd(new Date(2026, 0, 5))).toBe("2026-01-05"); });
  it("ago is coarse and honest", () => { const m = (n: number) => new Date(Date.now() - n * 60_000).toISOString(); expect(ago(null)).toBe("never"); expect(ago(m(0))).toBe("just now"); expect(ago(m(10))).toBe("10 min ago"); expect(ago(m(180))).toBe("3 h ago"); expect(ago(m(3000))).toBe("2 d ago"); });
  it("flag labels are readable; unknown flags are humanised, not hidden", () => { expect(flagLabel("negative_stock")).toBe("Stock below zero"); expect(flagLabel("some_new_flag")).toBe("some new flag"); });
});
describe("router and query strings", () => {
  it("parses #/domain/page/id and defaults to Today", () => { expect(parse("#/sell/orders/abc")).toEqual({ domain: "sell", page: "orders", id: "abc" }); expect(parse("")).toEqual({ domain: "today", page: "overview", id: undefined }); expect(parse("#/stock")).toMatchObject({ domain: "stock", page: "products" }); });
  it("href builds the same shape", () => { expect(href("sell", "orders")).toBe("#/sell/orders"); expect(href("sell", "orders", "x")).toBe("#/sell/orders/x"); });
  it("qs drops empty values and encodes the rest", () => { expect(qs({ a: "x y", b: undefined, c: "", d: 0, e: false, f: null })).toBe("?a=x+y&d=0"); expect(qs({})).toBe(""); });
});
