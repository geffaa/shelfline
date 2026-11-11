import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { catalogWorld as catalogWorldFor, reset, startApp, world, type Harness } from "./helpers";


let h: Harness;
beforeAll(async () => { h = await startApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await reset(h); });

const catalogWorld = () => catalogWorldFor(h);
const csvPost = (tok: string, body: string, q = "") => h.http().post(`/catalog/import${q}`).set("Authorization", `Bearer ${tok}`).set("Content-Type", "text/csv").send(body);

describe("tax classes and rates", () => {
  it("rejects overlapping rates for the same class and region; resolves region overrides and dates", async () => {
    const c = await catalogWorld();
    expect((await c.owner.post(`/tax-classes/${c.gst.id}/rates`, { rateBp: 1100, inclusive: true, validFrom: "2026-01-01" })).status).toBe(409);
    expect((await c.owner.post(`/tax-classes/${c.gst.id}/rates`, { region: "AU-WA", rateBp: 1200, inclusive: true, validFrom: "2026-01-01", validTo: "2027-01-01" })).status).toBe(201);
    expect((await c.owner.post(`/tax-classes/${c.gst.id}/rates`, { region: "AU-WA", rateBp: 1300, inclusive: true, validFrom: "2026-06-01" })).status).toBe(409);
    expect((await c.owner.get(`/tax-classes/${c.gst.id}/resolve?date=2026-06-01&region=AU-WA`)).body).toEqual({ rateBp: 1200, inclusive: true });
    expect((await c.owner.get(`/tax-classes/${c.gst.id}/resolve?date=2027-01-01&region=AU-WA`)).body).toEqual({ rateBp: 1000, inclusive: true });
    expect((await c.owner.get(`/tax-classes/${c.gst.id}/resolve?date=1999-01-01`)).status).toBe(404);
    expect((await c.owner.get(`/tax-classes/${c.gst.id}/resolve?date=bad`)).status).toBe(400);
  });
});

describe("products and variants", () => {
  it("creates a product with variants; lookup by barcode and SKU works", async () => {
    const c = await catalogWorld();
    const r = await c.hqApi.post("/products", c.glide);
    expect(r.status).toBe(201); expect(r.body.variants).toHaveLength(2);
    const byBar = await c.hqApi.get("/variants/lookup?barcode=9300000100105");
    expect(byBar.body.variant.sku).toBe("TG3-M-105-BW"); expect(byBar.body.product).toMatchObject({ title: "Tempra Glide 3", taxClassKey: "gst" });
    expect((await c.hqApi.get("/variants/lookup?sku=%20tg3-m-10-bw%20")).body.variant.barcode).toBe("9300000100101");
    expect((await c.hqApi.get("/variants/lookup?barcode=0000000000")).status).toBe(404);
    expect((await c.hqApi.get("/variants/lookup")).status).toBe(400);
  });
  it("rejects a duplicate SKU regardless of case or spaces, naming the SKU; duplicate barcode too", async () => {
    const c = await catalogWorld();
    await c.hqApi.post("/products", c.glide);
    const dup = await c.hqApi.post("/products", { title: "Other", taxClassId: c.gst.id, variants: [{ sku: "tg3-m-10-bw", basePriceMinor: 100 }] });
    expect(dup.status).toBe(409); expect(dup.body).toMatchObject({ code: "sku_exists", sku: "tg3-m-10-bw" });
    const dupBar = await c.hqApi.post("/products", { title: "Other", taxClassId: c.gst.id, variants: [{ sku: "X-1", barcode: "9300000100101", basePriceMinor: 100 }] });
    expect(dupBar.body.code).toBe("barcode_exists");
    expect((await c.hqApi.get("/products")).body.items).toHaveLength(1); // failed creates leave nothing behind
    const inReq = await c.hqApi.post("/products", { title: "Twin", taxClassId: c.gst.id, variants: [{ sku: "A-1", basePriceMinor: 1 }, { sku: "a-1", basePriceMinor: 2 }] });
    expect(inReq.status).toBe(400);
  });
  it("10 concurrent creates of the same SKU: exactly one wins", async () => {
    const c = await catalogWorld();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => c.hqApi.post("/products", { title: `Race ${i}`, taxClassId: c.gst.id, variants: [{ sku: "RACE-1", basePriceMinor: 100 }] })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(9);
    const { rows } = await h.db.execute(sql`select count(*)::int as n from shelfline.variant where sku = 'RACE-1'`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
  it("validates input: negative or fractional price, bad SKU, unknown tax class and category", async () => {
    const c = await catalogWorld();
    const bad = (v: object) => c.hqApi.post("/products", { title: "T", taxClassId: c.gst.id, variants: [v] });
    expect((await bad({ sku: "A-1", basePriceMinor: -1 })).status).toBe(400);
    expect((await bad({ sku: "A-1", basePriceMinor: 10.5 })).status).toBe(400);
    expect((await bad({ sku: "has space", basePriceMinor: 1 })).status).toBe(400);
    expect((await c.hqApi.post("/products", { title: "T", taxClassId: "6f0c1f1e-4b7e-4f0a-9d1e-0a0a0a0a0a0a", variants: [] })).body.code).toBe("unknown_tax_class");
    expect((await c.hqApi.post("/products", { title: "T", taxClassId: c.gst.id, categoryId: "6f0c1f1e-4b7e-4f0a-9d1e-0a0a0a0a0a0a", variants: [] })).body.code).toBe("unknown_category");
  });
  it("a price change is audited with before and after, and bumps the catalogue version on the row", async () => {
    const c = await catalogWorld();
    const p = (await c.hqApi.post("/products", c.glide)).body;
    const v0 = (await c.hqApi.get("/catalog/version")).body.seq;
    const upd = await c.hqApi.patch(`/variants/${p.variants[0].id}`, { basePriceMinor: 22995 });
    expect(upd.status).toBe(200); expect(upd.body.basePriceMinor).toBe(22995); expect(upd.body.version).toBe(v0 + 1);
    const a = (await c.owner.get("/audit?action=variant.price_change")).body[0];
    expect(a.before.basePriceMinor).toBe(21995); expect(a.after.basePriceMinor).toBe(22995); expect(a.actorId).toBe(c.hq.id);
    expect((await c.hqApi.get("/catalog/version")).body.seq).toBe(v0 + 1);
    expect((await c.hqApi.patch(`/variants/${p.variants[0].id}`, { trackStock: false })).status).toBe(200);
    expect((await c.owner.get("/audit?action=variant.update")).body).toHaveLength(1);
  });
  it("search by title, SKU and barcode; keyset pagination covers every product once; archived filter; % is literal", async () => {
    const c = await catalogWorld();
    for (let i = 0; i < 7; i++) await c.hqApi.post("/products", { title: `Item ${String(i).padStart(2, "0")}`, taxClassId: c.gst.id, variants: [{ sku: `IT-${i}`, barcode: `930000000${100 + i}`, basePriceMinor: 1000 + i }] });
    const seen: string[] = []; let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await c.hqApi.get(`/products?limit=3${after ? `&after=${after}` : ""}`);
      seen.push(...r.body.items.map((p: { title: string }) => p.title));
      if (!r.body.next) break; after = r.body.next;
    }
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `Item ${String(i).padStart(2, "0")}`));
    expect((await c.hqApi.get("/products?q=item 03")).body.items.map((p: { title: string }) => p.title)).toEqual(["Item 03"]);
    expect((await c.hqApi.get("/products?q=IT-5")).body.items).toHaveLength(1);
    expect((await c.hqApi.get("/products?q=930000000102")).body.items[0].title).toBe("Item 02");
    const id = (await c.hqApi.get("/products?q=Item 01")).body.items[0].id;
    await c.hqApi.patch(`/products/${id}`, { status: "archived" });
    expect((await c.hqApi.get("/products?status=archived")).body.items).toHaveLength(1);
    expect((await c.hqApi.get("/products?q=100%25")).body.items).toHaveLength(0);
  });
});

describe("permissions", () => {
  it("cashier and store manager read but cannot change; no token is 401; a POS token can read but not write", async () => {
    const c = await catalogWorld();
    await c.hqApi.post("/products", c.glide);
    expect((await c.mgr.get("/products")).status).toBe(200);
    expect((await c.mgr.post("/products", c.glide)).status).toBe(403);
    expect((await c.mgr.patch("/variants/6f0c1f1e-4b7e-4f0a-9d1e-0a0a0a0a0a0a", { basePriceMinor: 1 })).status).toBe(403);
    expect((await c.mgr.post("/catalog/import", {})).status).toBe(403);
    expect((await h.http().get("/products")).status).toBe(401);
    const pos = (await h.http().post("/pos/pin").set("x-device-key", c.device.key).send({ employeeCode: "117", pin: "4821" })).body.token;
    expect((await h.http().get("/products").set("Authorization", `Bearer ${pos}`)).status).toBe(200);
    expect((await h.http().post("/products").set("Authorization", `Bearer ${pos}`).send(c.glide)).status).toBe(401);
  });
});

describe("CSV import", () => {
  const header = "product_title,brand,category,tax_class,sku,barcode,price,cost,option_size,option_colour";
  function bigFile() {
    const lines = [header]; const bad = new Set<number>();
    for (let p = 0; p < 1000; p++) for (let s = 0; s < 5; s++) {
      const n = p * 5 + s;
      lines.push(`Product ${String(p).padStart(4, "0")},Tempra,Running shoes,gst,SKU-${n},93${String(n).padStart(11, "0")},${(10 + (n % 200)).toFixed(2)},4.10,${8 + s},Black`);
    }
    // 12 faults; the file line of data row n is n + 2 (header is line 1)
    const breakRow = (n: number, f: (c: string[]) => string[]) => { bad.add(n + 2); lines[n + 1] = f(lines[n + 1]!.split(",")).join(","); };
    breakRow(3, (c) => { c[6] = "ten dollars"; return c; });
    breakRow(40, (c) => { c[6] = "1.005"; return c; });
    breakRow(77, (c) => { c[3] = "vat"; return c; });
    breakRow(120, (c) => { c[0] = ""; return c; });
    breakRow(333, (c) => { c[4] = "has space"; return c; });
    breakRow(500, (c) => { c[5] = "12"; return c; });
    breakRow(900, (c) => { c[4] = "SKU-1"; return c; });          // repeats the SKU of an earlier row
    breakRow(1500, (c) => { c[7] = "free"; return c; });
    breakRow(2200, (c) => { c[6] = ""; return c; });
    breakRow(3000, (c) => { c[4] = ""; return c; });
    breakRow(4000, (c) => { c[5] = lines[2]!.split(",")[5]!; return c; }); // repeats the barcode of row 1
    breakRow(4900, (c) => { c[6] = "-5"; return c; });
    return { text: lines.join("\r\n") + "\r\n", bad };
  }

  it("5,000 rows with 12 faults: the 4,988 good rows import, each fault is reported by file line", async () => {
    const c = await catalogWorld();
    const { text, bad } = bigFile();
    const t0 = Date.now();
    const r = await csvPost(c.hqTok, text);
    const ms = Date.now() - t0;
    expect(r.status).toBe(201);
    expect(r.body.rows).toBe(5000);
    expect(r.body.errors).toHaveLength(12);
    expect(new Set(r.body.errors.map((e: { line: number }) => e.line))).toEqual(bad);
    expect(r.body.imported.variants).toBe(4988);
    const { rows } = await h.db.execute(sql`select count(*)::int as v from shelfline.variant`);
    expect((rows[0] as { v: number }).v).toBe(4988);
    expect(ms).toBeLessThan(15_000);
    const one = (await c.hqApi.get("/variants/lookup?sku=SKU-1")).body.variant;
    expect(one.basePriceMinor).toBe(1100); expect(one.costMinor).toBe(410); expect(one.options).toEqual({ size: "9", colour: "Black" });
    expect((await c.hqApi.get("/categories")).body.map((x: { name: string }) => x.name)).toEqual(["Running shoes"]);
    expect((await c.owner.get("/audit?action=catalog.import")).body[0].detail).toMatchObject({ rows: 5000, rejected: 12 });
  });
  it("dry run writes nothing; importing the same file again rejects every row as existing", async () => {
    const c = await catalogWorld();
    const csv = `${header}\nGlide,Tempra,Running shoes,gst,G-1,930000000001,219.95,,10,Black\nGlide,Tempra,Running shoes,gst,G-2,930000000002,219.95,,10.5,Black\n`;
    const dry = await csvPost(c.hqTok, csv, "?dryRun=true");
    expect(dry.body).toMatchObject({ dryRun: true, imported: { products: 1, variants: 2 }, errors: [] });
    expect((await c.hqApi.get("/products")).body.items).toHaveLength(0);
    expect((await csvPost(c.hqTok, csv)).body.imported).toEqual({ products: 1, variants: 2 });
    const again = await csvPost(c.hqTok, csv);
    expect(again.body.imported).toEqual({ products: 0, variants: 0 });
    expect(again.body.errors.map((e: { errors: string[] }) => e.errors[0])).toEqual(["sku already exists", "sku already exists"]);
    expect((await c.hqApi.get("/products")).body.items).toHaveLength(1);
  });
  it("adds variants to an existing product with the same title, brand and tax class", async () => {
    const c = await catalogWorld();
    const mk = (sku: string) => `${header}\nGlide,Tempra,,gst,${sku},,100.00,,10,Black\n`;
    expect((await csvPost(c.hqTok, mk("G-1"))).body.imported).toEqual({ products: 1, variants: 1 });
    expect((await csvPost(c.hqTok, mk("G-2"))).body.imported).toEqual({ products: 0, variants: 1 });
    expect((await c.hqApi.get("/products")).body.items[0].variantCount).toBe(2);
  });
  it("handles quoted commas, quotes and newlines, and a BOM; a price like \"1,234.00\" is reported, not guessed", async () => {
    const c = await catalogWorld();
    const csv = `﻿${header}\n"Trail ""Pro"", 2nd gen",Tempra,,gst,TP-1,,"1,234.00",,,\n"Multi\nline",Tempra,,gst,TP-2,,12.50,,,\n`;
    const r = await csvPost(c.hqTok, csv);
    expect(r.body.imported.variants).toBe(1);
    expect(r.body.errors).toHaveLength(1); expect(r.body.errors[0].line).toBe(2);
    expect((await c.hqApi.get("/products?q=Multi")).body.items[0].title).toBe("Multi\nline");
  });
  it("rejects a file without required columns, an unterminated quote, an empty body and too many rows", async () => {
    const c = await catalogWorld();
    expect((await csvPost(c.hqTok, "product_title,sku\nA,B\n")).body).toMatchObject({ code: "csv_missing_column", column: "tax_class" });
    expect((await csvPost(c.hqTok, `${header}\n"unterminated,x\n`)).body.code).toBe("csv_malformed");
    expect((await csvPost(c.hqTok, "   ")).status).toBe(400);
    expect((await csvPost(c.hqTok, `${header}\n` + "A,B,C,gst,S,,1.00,,,\n".repeat(20_001))).body.code).toBe("csv_too_large");
  });
});
