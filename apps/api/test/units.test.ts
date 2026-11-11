import { describe, expect, it } from "vitest";
import { businessDate } from "../src/common/business-day";
import { decrypt, encrypt } from "../src/common/crypto";
import { RateLimiter } from "../src/common/ratelimit";

describe("businessDate", () => {
  it("02:30 local with a 04:00 cutoff belongs to the previous day (PRD F1)", () => {
    expect(businessDate(new Date("2026-11-03T15:30:00Z"), "Australia/Melbourne", "04:00")).toBe("2026-11-03"); // 02:30 AEDT on 4 Nov
    expect(businessDate(new Date("2026-11-03T17:00:00Z"), "Australia/Melbourne", "04:00")).toBe("2026-11-04"); // 04:00 AEDT
  });
  it("Perth has no daylight saving; Melbourne does (start 2026-10-04, end 2027-04-04)", () => {
    expect(businessDate(new Date("2026-11-03T19:59:00Z"), "Australia/Perth", "04:00")).toBe("2026-11-03");
    expect(businessDate(new Date("2026-11-03T20:00:00Z"), "Australia/Perth", "04:00")).toBe("2026-11-04");
    expect(businessDate(new Date("2026-10-03T15:59:00Z"), "Australia/Melbourne", "04:00")).toBe("2026-10-03"); // 01:59 AEST
    expect(businessDate(new Date("2026-10-03T17:00:00Z"), "Australia/Melbourne", "04:00")).toBe("2026-10-04"); // 17:00Z = 04:00 AEDT (UTC+11), exactly the cutoff
  });
  it("month boundary: 01:00 on 1 Dec belongs to 30 Nov", () => {
    expect(businessDate(new Date("2026-11-30T14:00:00Z"), "Australia/Melbourne", "04:00")).toBe("2026-11-30"); // 01:00 AEDT 1 Dec
  });
  it("rejects a bad cutoff", () => { expect(() => businessDate(new Date(), "UTC", "4am")).toThrow(); });
});

describe("crypto", () => {
  const key = Buffer.alloc(32, 7);
  it("round-trips and detects tampering", () => {
    const c = encrypt("JBSWY3DPEHPK3PXP", key);
    expect(c).not.toContain("JBSWY3DP");
    expect(decrypt(c, key)).toBe("JBSWY3DPEHPK3PXP");
    const [iv, tag, ct] = c.split(".");
    const flipped = Buffer.from(ct!, "base64"); flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([iv, tag, flipped.toString("base64")].join("."), key)).toThrow();
    expect(() => decrypt(c, Buffer.alloc(32, 8))).toThrow();
  });
});

describe("RateLimiter", () => {
  it("allows max per window then resets", () => {
    let t = 0; const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, false]);
    expect(rl.take("b")).toBe(true);
    t = 1001; expect(rl.take("a")).toBe(true);
  });
});

import { parseCsv, parsePriceMinor } from "../src/catalog/csv";
describe("parseCsv", () => {
  it("quotes, escaped quotes, embedded commas and newlines, CRLF, BOM, trailing newline", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"l1\nl2",z\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["l1\nl2", "z"]]);
  });
  it("keeps empty fields, skips blank lines, rejects an unterminated quote", () => {
    expect(parseCsv("a,,c\n\nd,e,\n")).toEqual([["a", "", "c"], ["d", "e", ""]]);
    expect(() => parseCsv('a,"b')).toThrow();
  });
});
describe("parsePriceMinor (no floats)", () => {
  it("parses major units to minor exactly", () => {
    expect(parsePriceMinor("219.95")).toBe(21995); expect(parsePriceMinor("219.9")).toBe(21990); expect(parsePriceMinor("219")).toBe(21900);
    expect(parsePriceMinor("0.07")).toBe(7); expect(parsePriceMinor("1.15")).toBe(115); // 1.15 * 100 === 114.99999999999999 in floats
  });
  it("rejects what it cannot read exactly", () => {
    for (const s of ["", "1.005", "-5", "1,234.00", "ten", "1e3", ".5", "1."]) expect(parsePriceMinor(s)).toBeNull();
  });
});

import { configureApp } from "../src/app.setup";
import request from "supertest";
import { startApp as startHarness } from "./helpers";
describe("CORS", () => {
  it("answers a preflight for the POS origin only, with the headers the till needs", async () => {
    const h = await startHarness();
    try {
      const ok = await request(h.app.getHttpServer()).options("/sync/push").set("Origin", "http://localhost:8210").set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "authorization,content-type,x-device-key");
      expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:8210"); expect(ok.headers["access-control-allow-headers"]).toMatch(/x-device-key/i);
      const bad = await request(h.app.getHttpServer()).options("/sync/push").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
      expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    } finally { await h.close(); }
  });
});
void configureApp;
