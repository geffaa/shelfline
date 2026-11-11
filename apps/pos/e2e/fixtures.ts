import { expect, type Page } from "@playwright/test";
import pg from "pg";

export const API = "http://localhost:8201";
const DB = "postgres://shelfline:shelfline@localhost:54340/shelfline_e2e";

async function http<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as T };
}
const rnd = () => Math.random().toString(36).slice(2, 8);

export interface Shop {
  tag: string; deviceKey: string; locationId: string; registerCode: string; variants: { id: string; sku: string; barcode: string; title: string; options: string }[];
  cashier: { code: string; pin: string; name: string }; manager: { code: string; pin: string; name: string }; ownerToken: string;
}

/** Fresh store, register, device, staff and three products with stock, created through the public API as the owner. */
export async function provisionShop(opts: { stock?: number } = {}): Promise<Shop> {
  const tag = rnd().toUpperCase();
  const owner = (await http("POST", "/auth/login", null, { email: "owner@e2e.test", password: "e2e-owner-password-123" })).body.token as string;
  const loc = (await http("POST", "/locations", owner, { code: `S${tag}`, name: `Fitzroy ${tag}`, type: "store", timezone: "Australia/Melbourne" })).body;
  const reg = (await http("POST", `/locations/${loc.id}/registers`, owner, { code: `FIT-${tag}`, name: "Front desk" })).body;
  const dev = (await http("POST", "/devices", owner, { kind: "pos", locationId: loc.id, registerId: reg.id, name: `iPad ${tag}` })).body;
  const cashier = { code: `C${tag}`, pin: "4821", name: `Priya ${tag}` }, manager = { code: `M${tag}`, pin: "7313", name: `Marcus ${tag}` };
  await http("POST", "/users", owner, { email: `priya.${tag}@e2e.test`, name: cashier.name, employeeCode: cashier.code, pin: cashier.pin, assignments: [{ role: "cashier", locationId: loc.id }] });
  await http("POST", "/users", owner, { email: `marcus.${tag}@e2e.test`, name: manager.name, employeeCode: manager.code, pin: manager.pin, assignments: [{ role: "store_manager", locationId: loc.id }] });
  const gst = (await http("GET", "/tax-classes", owner)).body.find((c: { key: string }) => c.key === "gst") ?? (await http("POST", "/tax-classes", owner, { key: "gst", name: "GST" })).body;
  if (!gst.rates?.length) await http("POST", `/tax-classes/${gst.id}/rates`, owner, { rateBp: 1000, inclusive: true, validFrom: "2000-07-01" });
  const defs = [
    { title: "Tempra Glide 3", sku: `TG3-${tag}`, options: { size: "10.5", colour: "Black/White" }, price: 21995 },
    { title: "Merino tee", sku: `MT-${tag}`, options: { size: "M", colour: "Slate" }, price: 8900 },
    { title: "Crew socks 2-pack", sku: `CS-${tag}`, options: { size: "L" }, price: 3400 },
  ];
  const variants: Shop["variants"] = [];
  for (const [i, d] of defs.entries()) {
    const barcode = `93${tag.replace(/\D/g, "").padEnd(3, "7")}${String(i)}${String(Date.now()).slice(-6)}`.padEnd(13, "0").slice(0, 13);
    const p = (await http("POST", "/products", owner, { title: d.title, taxClassId: gst.id, variants: [{ sku: d.sku, barcode, options: d.options, basePriceMinor: d.price }] })).body;
    expect(p.variants?.[0]?.id, JSON.stringify(p)).toBeTruthy();
    await http("POST", "/inventory/receive", owner, { locationId: loc.id, idempotencyKey: crypto.randomUUID(), lines: [{ variantId: p.variants[0].id, qty: opts.stock ?? 10, unitCostMinor: 5000 }] });
    variants.push({ id: p.variants[0].id, sku: d.sku, barcode, title: d.title, options: Object.values(d.options).join(" · ") });
  }
  return { tag, deviceKey: dev.key, locationId: loc.id, registerCode: reg.code, variants, cashier, manager, ownerToken: owner };
}

export async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  try { return (await c.query(query, params)).rows as T[]; } finally { await c.end(); }
}

/** Pair the iPad, sign in and open the register, ending on the Sell screen. */
export async function pairAndOpen(page: Page, shop: Shop, who = shop.cashier) {
  await page.goto("/");
  await page.getByLabel("Server address").fill(API);
  await page.getByLabel("Device key").fill(shop.deviceKey);
  await page.getByRole("button", { name: "Pair this iPad" }).click();
  await signIn(page, who);
  await expect(page.getByRole("heading", { name: "Open the register" })).toBeVisible({ timeout: 30_000 });
  // every denomination tile keeps its amount inside its own border
  const spill = await page.evaluate(() => [...document.querySelectorAll(".denom")].filter((t) => [...t.children].some((c) => c.getBoundingClientRect().right > t.getBoundingClientRect().right + 0.5)).length);
  expect(spill, "denomination tiles overflow").toBe(0);
  await page.getByRole("button", { name: "Increase A$100 count" }).click();
  await page.getByRole("button", { name: "Increase A$50 count" }).click();
  await page.getByRole("button", { name: /Open register with A\$150\.00/ }).click();
  await expect(page.getByLabel("Scan barcode or search products")).toBeVisible();
}
export async function signIn(page: Page, who: { code: string; pin: string }) {
  await page.getByLabel("Employee code").fill(who.code);
  for (const d of who.pin) await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
}
export async function addByBarcode(page: Page, code: string) { const box = page.getByLabel("Scan barcode or search products"); await box.fill(code); await box.press("Enter"); }
export async function queued(page: Page) { const t = await page.getByTestId("sync-pill").innerText(); const m = /(\d+) (saved|sending)/.exec(t); return m ? Number(m[1]) : 0; }

export async function ownerPatchLocation(shop: Shop, patch: object) { const r = await http("PATCH", `/locations/${shop.locationId}`, shop.ownerToken, patch); expect(r.status).toBe(200); }
export async function typeDigits(page: Page, digits: string) { for (const d of digits) await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: d, exact: true }).click(); }
