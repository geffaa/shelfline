import { expect, test, type Page } from "@playwright/test";
import { http, ownerToken, provisionWorld, sql } from "../../admin/e2e/fixtures";

const shot = (page: Page, name: string) => page.screenshot({ path: `../../.impeccable/review/shop-${name}.png`, fullPage: true });
const onHand = async (variantId: string, locationId: string) => Number((await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [variantId, locationId]))[0]?.n ?? 0);

test("browse, choose a size and a store, reserve the last pair, and be told when someone else got it first", async ({ page, browser }) => {
  const w = await provisionWorld({ stock: 1 }); const [a, b] = w.stores as [typeof w.stores[0], typeof w.stores[0]]; const owner = await ownerToken(); const v0 = a!.variants[0]!;
  expect((await http("PATCH", `/locations/${a!.id}`, owner, { pickupEnabled: true })).status).toBe(200);          // only the first store takes pickups
  const org = (await http<{ orgId: string }>("GET", "/shop-default", null)).body.orgId;

  // the shop window
  await page.goto("/"); await expect(page.getByRole("heading", { name: "What is in stock near you" })).toBeVisible(); await expect(page.getByText(`Collect from ${a!.name}`)).toBeVisible(); await expect(page.getByText(b!.name)).toHaveCount(0); await shot(page, "home");
  await page.getByLabel("Search products").fill("Tempra"); await page.getByRole("button", { name: "Search" }).click(); await expect(page.getByTestId("product-card")).toContainText("Tempra Glide 3"); await expect(page.getByTestId("product-card").first()).toContainText("Only 1 left");

  // a product: the option, where it can be collected, add to basket
  await page.getByTestId("product-card").first().click(); await expect(page.getByRole("heading", { name: "Tempra Glide 3" })).toBeVisible(); const avail = page.getByTestId("availability"); await expect(avail).toContainText(a!.name); await expect(avail).toContainText("1 left"); await expect(avail).not.toContainText(b!.name); await shot(page, "product");
  await page.getByRole("button", { name: "Add to basket" }).click(); await expect(page.getByTestId("added")).toBeVisible(); await expect(page.getByTestId("cart-link")).toContainText("1");

  // a second shopper has the same pair in their basket (their page was opened before anyone ordered)
  const other = await browser.newContext(); const p2 = await other.newPage(); await p2.goto(`/`); await p2.getByTestId("product-card").filter({ hasText: "Tempra Glide 3" }).click(); await p2.getByRole("button", { name: "Add to basket" }).click(); await p2.goto("/cart");
  await p2.getByLabel("Name").fill("Late Larry"); await p2.getByLabel("Email").fill(`larry.${a!.tag}@example.com`);

  // the first shopper reserves it
  await page.getByRole("link", { name: "View basket" }).click(); await expect(page.getByTestId("basket")).toContainText("Tempra Glide 3"); await expect(page.getByTestId("basket-total")).toContainText("219.95");
  const checkout = page.getByRole("form", { name: "Reserve" }); await expect(checkout.getByRole("button", { name: "Reserve and pay in store" })).toBeDisabled(); await checkout.getByLabel("Name").fill("Sam Buyer"); await checkout.getByLabel("Email").fill(`sam.${a!.tag}@example.com`); await shot(page, "cart");
  await checkout.getByRole("button", { name: "Reserve and pay in store" }).click(); await expect(page.getByTestId("order-status")).toHaveText("Reserved"); const code = (await page.getByTestId("pickup-code").innerText()).trim(); expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/); await expect(page.getByTestId("order-lines")).toContainText("Tempra Glide 3"); await shot(page, "order");
  expect(await onHand(v0.id, a!.id)).toBe(0); await expect(page.getByTestId("cart-link")).toContainText("0");
  expect((await http<any[]>("GET", `/dev/mailbox?to=sam.${a!.tag}@example.com`, null)).body[0].body).toContain(code);

  // the second shopper presses the button: told plainly, nothing reserved, their basket is kept
  await p2.getByRole("form", { name: "Reserve" }).getByRole("button", { name: "Reserve and pay in store" }).click(); await expect(p2.getByTestId("checkout-error")).toContainText("has just sold out at this store"); await expect(p2.getByTestId("checkout-error")).toContainText("Nothing has been reserved"); await expect(p2.getByTestId("basket")).toContainText("Tempra Glide 3");
  expect((await sql(`select count(*)::int as n from shelfline.online_order`))[0]!.n).toBe(1);

  // the first shopper cancels: the pair is back, and the second shopper gets it
  await page.getByRole("button", { name: "Cancel this order" }).click(); await expect(page.getByTestId("order-status")).toHaveText("Cancelled"); expect(await onHand(v0.id, a!.id)).toBe(1);
  await p2.getByRole("form", { name: "Reserve" }).getByRole("button", { name: "Reserve and pay in store" }).click(); await expect(p2.getByTestId("order-status")).toHaveText("Reserved"); expect(await onHand(v0.id, a!.id)).toBe(0); await other.close(); void org;
});

test("a staff member marks it ready and the customer's page follows; the options are real controls you can use with a keyboard; a phone gets a single column", async ({ page }) => {
  const w = await provisionWorld({ stock: 5 }); const a = w.stores[0]!; const owner = await ownerToken(); await http("PATCH", `/locations/${a.id}`, owner, { pickupEnabled: true });
  await page.goto("/"); await page.getByTestId("product-card").filter({ hasText: "Merino tee" }).filter({ hasText: "Only 5 left" }).click(); const group = page.getByRole("radiogroup", { name: "Option" }); await expect(group.getByRole("radio")).toHaveCount(1);
  await page.getByRole("button", { name: "More quantity" }).click(); await expect(page.getByLabel("Quantity", { exact: false }).first()).toBeVisible(); await page.getByRole("button", { name: "Add to basket" }).click(); await page.goto("/cart");
  const checkout = page.getByRole("form", { name: "Reserve" }); await checkout.getByLabel("Name").fill("Kim"); await checkout.getByLabel("Email").fill(`kim.${a.tag}@example.com`);
  const store = checkout.getByRole("radiogroup", { name: "Store" }); const mine = store.getByRole("radio", { name: a.name }); await expect(mine).toHaveAttribute("aria-checked", "false"); await mine.focus(); await page.keyboard.press("Space"); await expect(mine).toHaveAttribute("aria-checked", "true");        // chosen from the keyboard
  const others = store.getByRole("radio").filter({ hasNotText: a.name }); await page.keyboard.press("ArrowRight"); await expect(others.first()).toHaveAttribute("aria-checked", "true"); await page.keyboard.press("ArrowLeft"); await expect(mine).toHaveAttribute("aria-checked", "true");
  await checkout.getByRole("button", { name: "Reserve and pay in store" }).click(); await expect(page.getByTestId("order-status")).toHaveText("Reserved"); await expect(page.getByTestId("order-lines")).toContainText("2 × Merino tee");
  const [o] = await sql(`select id from shelfline.online_order order by placed_at desc limit 1`); expect((await http("POST", `/online-orders/${o.id}/ready`, owner)).status).toBe(200);
  await expect(page.getByTestId("order-status")).toHaveText("Ready to collect", { timeout: 25_000 });                                                            // the page refreshes itself
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await shot(page, "phone");
  await page.getByTestId("product-card").first().click(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a link without its secret shows nothing, and an unknown product is not found", async ({ page }) => {
  await provisionWorld({ stock: 1 }); const r = await page.goto(`/order/00000000-0000-4000-8000-000000000000?t=nope`); expect(r?.status()).toBe(404);
  const r2 = await page.goto(`/p/00000000-0000-4000-8000-000000000000`); expect(r2?.status()).toBe(404);
});
