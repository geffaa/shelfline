#!/usr/bin/env node
/**
 * Screenshots of the running demo (docs/screenshots/*.png). Needs the demo seeded (`pnpm demo:seed`), the API on :8200, admin on :8220, POS on :8210.
 *   node tools/screenshots.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
const { chromium } = createRequire(new URL("../apps/admin/package.json", import.meta.url))("@playwright/test");
const devices = JSON.parse(readFileSync(new URL("../apps/api/.demo-devices.json", import.meta.url), "utf8"));
const out = new URL("../docs/screenshots/", import.meta.url).pathname; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const shot = async (page, name) => { await page.waitForTimeout(700); await page.screenshot({ path: `${out}${name}.png` }); console.log("saved", name); };

const pickFitzroy = async (p) => { await p.getByRole("complementary", { name: "Locations" }).getByRole("button", { name: /^Fitzroy/ }).click(); await p.waitForTimeout(1500); };
// ---- back office
async function admin(w, h, tag, pages) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 }); const page = await ctx.newPage();
  await page.goto("http://localhost:8220/"); await page.getByLabel("Email").fill("elena@kestrel.test"); await page.getByLabel("Password").fill("kestrel-demo-2026"); await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector(".domains, .mtabs", { state: "attached" });
  for (const [hash, name, prep] of pages) { await page.goto(`http://localhost:8220/#/${hash}`); await page.waitForTimeout(1200); if (prep) await prep(page); await shot(page, `admin-${name}-${tag}`); }
  await ctx.close();
}
await admin(1440, 900, "d", [["today/overview", "today"], ["today/sessions", "registers"], ["today/alerts", "alerts"], ["sell/orders", "orders"], ["stock/products", "products"], ["stock/inventory", "inventory"], ["money/reports", "reports"], ["stock/purchase-orders", "purchase-orders"], ["money/bills", "bills"], ["money/suppliers", "suppliers"], ["stock/transfers", "transfers"], ["stock/counts", "counts"], ["stock/pricing", "pricing"], ["sell/gift-cards", "gift-cards"], ["people/schedule", "schedule", pickFitzroy], ["people/timesheets", "timesheets", pickFitzroy], ["people/terminals", "terminals", pickFitzroy], ["money/commission", "commission", async (p) => { await p.getByRole("link", { name: /09-17|10-01/ }).first().click().catch(() => {}); await p.waitForTimeout(800); }], ["money/commission-rules", "commission-rules"], ["admin/locations", "locations"], ["today/inbox", "inbox"], ["admin/notifications", "notifications"], ["admin/end-of-day", "end-of-day"], ["admin/devices", "devices"], ["money/report-access", "report-access"], ["sell/online", "online-orders"], ["sell/channels", "channels"], ["grow/campaigns", "campaigns"], ["grow/loyalty", "loyalty"], ["money/accounting", "accounting"], ["stock/reorder", "reorder"], ["admin/sso", "sso"]]);
await admin(390, 844, "m", [["today/overview", "today"], ["today/alerts", "alerts"]]);

if (process.env.SHOTS === "admin") { await browser.close(); process.exit(0); }
// ---- the till (iPad landscape), paired to Fitzroy's front desk
{
  const d = devices.find((x) => x.register === "SYA-2");
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true }); const page = await ctx.newPage();
  await page.goto("http://localhost:8210/"); await page.getByLabel("Server address").fill(d.apiUrl); await page.getByLabel("Device key").fill(d.deviceKey); await page.getByRole("button", { name: "Pair this iPad" }).click();
  await page.getByLabel("Employee code").fill(d.employeeCode); for (const c of d.pin) await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: c, exact: true }).click(); await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Open the register" }).waitFor({ timeout: 60_000 }); await shot(page, "pos-open");
  await page.getByRole("button", { name: "Increase A$100 count" }).click(); await page.getByRole("button", { name: "Increase A$50 count" }).click(); await page.getByRole("button", { name: /Open register with/ }).click();
  const box = page.getByLabel("Scan barcode or search products");
  for (const q of ["Glide 1", "Run tee A", "Gel Citrus", "Crew sock 1"]) { await box.fill(q); await page.getByTestId("result").first().click(); }
  await shot(page, "pos-sell");
  await page.getByRole("link", { name: /Sync/ }).click(); await shot(page, "pos-sync");
  await ctx.close();
}
await browser.close();
