import { expect, test, type Page } from "@playwright/test";
import { API, addByBarcode, pairAndOpen, provisionShop, queued, signIn, sql, type Shop } from "./fixtures";

const apiPost = async (token: string, path: string, body: unknown, method = "POST") => { const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
const line = (page: Page, text: string) => page.getByTestId("cart-line").filter({ hasText: text });
async function addBySearch(page: Page, q: string) { await page.getByLabel("Scan barcode or search products").fill(q); await page.getByTestId("result").first().click(); }
async function discount(page: Page, itemText: string, pct: string, reason = "Staff or friends and family") {
  await line(page, itemText).getByRole("button", { name: "Discount" }).click();
  await page.getByRole("radio", { name: pct, exact: true }).click();
  await page.getByRole("combobox", { name: "Discount reason" }).click(); await page.getByRole("option", { name: reason }).click();
}
/** The till's own counter can read 0 before the first push has even started, so wait for the server to have the sale(s), then for the queue to drain. */
const waitSent = async (page: Page, shop: Shop, n = 1) => {
  await expect.poll(async () => (await sql(`select count(*)::int as n from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]))[0]!.n, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
  await expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
};
const shot = (page: Page, name: string) => page.screenshot({ path: `../../.impeccable/review/pos-${name}.png` });

test.describe("selling", () => {
  test("three items, a discount and a split cash + card payment: the till and the server agree to the cent", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addBySearch(page, shop.variants[0]!.sku);
    await addByBarcode(page, shop.variants[1]!.barcode);                       // a scanner types the code and presses Enter
    await addBySearch(page, shop.variants[2]!.sku);
    await page.getByRole("button", { name: /increase crew socks 2-pack quantity/i }).click();
    await discount(page, "Merino tee", "10%");
    await page.getByRole("button", { name: "Apply discount" }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(3);
    await expect(page.getByTestId("cart-total")).toHaveText("A$368.05");
    await shot(page, "sell");

    await page.getByRole("button", { name: /^Pay A\$368\.05/ }).click();
    await expect(page.getByTestId("pay-total")).toHaveText("A$368.05");
    for (const d of "10000") await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "Add cash A$100.00" }).click();
    await page.getByRole("radio", { name: "Card", exact: true }).click();
    await expect(page.getByTestId("pay-remaining")).toHaveText("A$268.05");
    await page.getByLabel("Reference (optional)").fill("TERM 0042");
    await shot(page, "pay");
    await page.getByRole("button", { name: "Add card A$268.05" }).click();
    await expect(page.getByTestId("tender-line")).toHaveCount(2);
    await page.getByRole("button", { name: "Complete sale" }).click();

    await expect(page.getByTestId("receipt")).toContainText("368.05");
    await expect(page.getByTestId("receipt")).toContainText(`FIT-${shop.tag}-000001`);
    await shot(page, "receipt");
    await waitSent(page, shop);
    const [s] = await sql(`select s.id, s.total_minor, s.tax_minor, s.discount_minor, s.flags, s.receipt_no from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]);
    expect(s).toMatchObject({ total_minor: 36805, tax_minor: 3346, discount_minor: 890, flags: [], receipt_no: `FIT-${shop.tag}-000001` });
    const pays = await sql(`select tender, amount_minor, reference from shelfline.payment where sale_id = $1 order by id`, [s.id]);
    expect(pays).toEqual([{ tender: "cash", amount_minor: 10000, reference: null }, { tender: "card", amount_minor: 26805, reference: "TERM 0042" }]);
    const stock = await sql(`select on_hand from shelfline.stock_balance b join shelfline.variant v on v.id = b.variant_id where v.sku = any($1) order by v.sku`, [shop.variants.map((v) => v.sku)]);
    expect(stock.map((r) => r.on_hand).sort()).toEqual([8, 9, 9]);           // glide 10-1, tee 10-1, socks 10-2
    expect(await sql(`select count(*)::int as n from shelfline.sync_exception e join shelfline.location l on l.code = $1 where e.org_id = l.org_id and e.created_at > now() - interval '5 minutes' and e.kind <> 'session_force_closed'`, [`S${shop.tag}`])).toEqual([{ n: 0 }]);
  });

  test("cash with change and 5c rounding; an unknown barcode says so; the cart survives a reload", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addByBarcode(page, "9999999999999");
    await expect(page.getByText("Nothing found for")).toBeVisible();
    await addByBarcode(page, shop.variants[2]!.barcode);
    await expect(page.getByTestId("cart-total")).toHaveText("A$34.00");
    await expect.poll(() => page.evaluate(() => new Promise<boolean>((res) => { const r = indexedDB.open("shelfline-pos"); r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("draft\u0000cart"); q.onsuccess = () => { r.result.close(); res(!!q.result); }; }; r.onerror = () => res(false); }))).toBe(true);
    await page.reload(); await expect(page.getByTestId("cart-line")).toHaveCount(1);                 // a draft, not only memory
    await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click();
    await page.getByRole("button", { name: "A$50.00" }).click();                                      // quick tender
    await expect(page.getByTestId("change-due")).toHaveText("A$16.00");
    await page.getByRole("button", { name: "Complete sale" }).click();
    await expect(page.getByTestId("change-due")).toHaveText("A$16.00");
    await waitSent(page, shop);
    const [s] = await sql(`select change_minor, tendered_minor, total_minor from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]);
    expect(s).toEqual({ change_minor: 1600, tendered_minor: 5000, total_minor: 3400 });
  });

  test("a discount over the cashier's limit needs a manager's PIN, and the approval is recorded with the sale", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addBySearch(page, shop.variants[0]!.sku); await discount(page, "Tempra Glide 3", "20%", "Price match");
    await expect(page.getByText(/must approve with their PIN/)).toBeVisible();
    await page.getByRole("button", { name: "Ask a manager" }).click();
    await expect(page.getByRole("complementary", { name: "Manager approval" })).toBeVisible();
    await page.getByLabel("Manager employee code").fill(shop.cashier.code);                            // a cashier cannot approve
    for (const d of shop.cashier.pin) await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("alert")).toContainText("cannot approve");
    await page.getByLabel("Manager employee code").fill(shop.manager.code);
    for (const d of shop.manager.pin) await page.getByRole("group", { name: "Number pad" }).getByRole("button", { name: d, exact: true }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(line(page, "Tempra Glide 3")).toContainText(`approved by ${shop.manager.name}`);
    await expect(page.getByTestId("cart-total")).toHaveText("A$175.96");
    await page.getByRole("button", { name: /^Pay/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await waitSent(page, shop);
    const [l] = await sql(`select sl.approved_by, sl.discount_minor, s.flags from shelfline.sale_line sl join shelfline.sale s on s.id = sl.sale_id join shelfline.location loc on loc.id = s.location_id where loc.code = $1`, [`S${shop.tag}`]);
    expect(l.approved_by).not.toBeNull(); expect(l.discount_minor).toBe(4399); expect(l.flags).toEqual([]);
  });

  test("parking a sale and recalling it; the sale in progress is parked, not lost", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addBySearch(page, shop.variants[0]!.sku); await page.getByRole("button", { name: "Park", exact: true }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(0);
    await addBySearch(page, shop.variants[2]!.sku);
    await page.getByRole("button", { name: /Parked \(1\)/ }).click(); await page.getByRole("button", { name: "Recall" }).click();
    await expect(line(page, "Tempra Glide 3")).toHaveCount(1); await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await page.getByRole("button", { name: /Parked \(1\)/ }).click();
    await expect(page.getByText(/1 item/)).toBeVisible();                                              // the socks, parked automatically
  });
});

test.describe("sign in", () => {
  test("wrong PIN is refused without revealing which part was wrong; five wrong PINs lock the account", async ({ page }) => {
    const shop = await provisionShop(); await page.goto("/");
    await page.getByLabel("Server address").fill("http://localhost:8201"); await page.getByLabel("Device key").fill(shop.deviceKey); await page.getByRole("button", { name: "Pair this iPad" }).click();
    for (let i = 0; i < 5; i++) { await signIn(page, { code: shop.cashier.code, pin: "0000" }); await expect(page.getByRole("alert")).toContainText(i < 4 ? "do not match" : "do not match"); }
    await signIn(page, shop.cashier);
    await expect(page.getByRole("alert")).toContainText("Too many wrong PINs");
  });
});

test.describe("offline", () => {
  test("sell with no network, reload with no network, reconnect: exactly one sale, stock down once, nothing lost", async ({ page, context }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);   // the shell is cached and versioned
    await context.setOffline(true);
    await expect(page.getByTestId("sync-pill")).toContainText("Offline");
    await expect(page.getByText("You can keep selling.")).toBeVisible();
    await addByBarcode(page, shop.variants[0]!.barcode); await addByBarcode(page, shop.variants[0]!.barcode);
    await page.getByRole("button", { name: /^Pay A\$439\.90/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await expect(page.getByText("Waiting to send")).toBeVisible();
    await expect(page.getByTestId("sync-pill")).toContainText("Offline · 1 saved");
    await shot(page, "offline-receipt");
    await page.getByRole("button", { name: "New sale" }).click();
    // stock shown on the till already accounts for the unsent sale (10 - 2)
    await page.getByLabel("Scan barcode or search products").fill(shop.variants[0]!.sku); await expect(page.getByTestId("result").first()).toContainText("8"); await shot(page, "offline-sell");

    await page.reload();                                                                                  // still offline: the app opens from its cache
    await expect(page.getByLabel("Scan barcode or search products")).toBeVisible();
    await expect(page.getByTestId("sync-pill")).toContainText("Offline · 1 saved");                    // the queue survived the reload
    expect(await sql(`select count(*)::int as n from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`])).toEqual([{ n: 0 }]);

    await context.setOffline(false);
    await waitSent(page, shop);
    const sales = await sql(`select s.receipt_no, s.total_minor, s.flags from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]);
    expect(sales).toEqual([{ receipt_no: `FIT-${shop.tag}-000001`, total_minor: 43990, flags: [] }]);
    const [b] = await sql(`select b.on_hand from shelfline.stock_balance b join shelfline.variant v on v.id = b.variant_id where v.sku = $1`, [shop.variants[0]!.sku]);
    expect(b.on_hand).toBe(8);                                                                              // down once, not twice
    await expect(page.getByTestId("sync-pill")).toContainText("Online");
  });

  test("a sale that arrives after the stock ran out is accepted and shows up as a note on the Sync screen", async ({ page, context }) => {
    const shop = await provisionShop({ stock: 1 }); await pairAndOpen(page, shop);
    await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
    await addByBarcode(page, shop.variants[0]!.barcode); await addByBarcode(page, shop.variants[0]!.barcode);
    await page.getByRole("button", { name: /^Pay/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await context.setOffline(false); await waitSent(page, shop);
    await page.getByRole("link", { name: /Sync/ }).click();
    await expect(page.getByText("Accepted with a note (1)")).toBeVisible(); await expect(page.getByText("Stock went below zero")).toBeVisible();
    await shot(page, "sync");
  });

  test("the Sync screen lists what is waiting, exports it as a file, and a server that needs a newer app blocks the till without losing anything", async ({ page, context }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await expect.poll(() => queued(page)).toBe(0);                                                      // the register opening has reached the server; only the sale below will wait
    await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
    await addByBarcode(page, shop.variants[1]!.barcode);
    await page.getByRole("button", { name: /^Pay/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await page.getByRole("link", { name: /Sync/ }).click();
    await expect(page.getByTestId("queue-list")).toContainText(`FIT-${shop.tag}-000001 · 1 items`); await expect(page.getByText("Waiting to send (1)")).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export unsent" }).click()]);
    const file = JSON.parse(await (await import("node:fs/promises")).readFile((await dl.path())!, "utf8"));
    expect(file).toMatchObject({ format: "shelfline-queue", version: 1 }); expect(file.commands.map((c: { type: string }) => c.type)).toEqual(["sale.create"]); expect(file.sales[0].receiptNo).toBe(`FIT-${shop.tag}-000001`);
    await shot(page, "sync-queue");

    // the server says this build is too old: the till is replaced by one calm screen, the sale stays on the iPad
    await page.route("**/sync/status", async (route) => { const real = await route.fetch(); await route.fulfill({ response: real, json: { ...(await real.json()), minSchemaV: 99 } }); });
    await page.route("**/sync/push", (route) => route.abort());
    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "Update required" })).toBeVisible();
    await expect(page.getByText("1 unsent item is saved safely on this iPad.")).toBeVisible(); await expect(page.getByRole("button", { name: "Export unsent items" })).toBeVisible();
    await shot(page, "update-required");
    expect(await sql(`select count(*)::int as n from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`])).toEqual([{ n: 0 }]);
  });
});

test.describe("touch targets", () => {
  async function audit(page: Page, where: string) {
    const bad = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button, [role=radio], [role=combobox], [role=switch], a[href], input")].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden"; })
      .map((e) => { const r = (e.closest("label.input, .input") ?? e).getBoundingClientRect(); return { name: (e.getAttribute("aria-label") ?? e.textContent ?? e.tagName).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.h < 48 || x.w < 48));
    expect(JSON.stringify(bad), `${where}: targets smaller than 48px`).toBe("[]");
  }
  test("every tappable control on the main selling screens is at least 48 px", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addBySearch(page, shop.variants[0]!.sku); await audit(page, "sell with a line");
    await line(page, "Tempra Glide 3").getByRole("button", { name: "Discount" }).click(); await audit(page, "discount editor");
    await page.getByRole("radio", { name: "5%", exact: true }).click(); await page.getByRole("combobox", { name: "Discount reason" }).click(); await page.getByRole("option", { name: "Loyalty" }).click(); await page.getByRole("button", { name: "Apply discount" }).click();
    await page.getByRole("button", { name: /^Pay/ }).click(); await audit(page, "payment");
    await page.getByRole("radio", { name: "Card", exact: true }).click(); await audit(page, "payment by card");
  });
  test("the cash, orders, shift and close-register screens meet the same 48 px floor", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addByBarcode(page, shop.variants[0]!.barcode); await page.getByRole("button", { name: /^Pay A\$/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click(); await page.getByRole("button", { name: "New sale" }).click();
    await page.getByRole("link", { name: "Cash" }).click(); await audit(page, "cash"); await page.getByRole("button", { name: "Pay out", exact: true }).click(); await audit(page, "cash entry");
    await page.getByRole("link", { name: "Orders" }).click(); await page.getByTestId("order-row").first().click(); await audit(page, "refund");
    await page.getByRole("link", { name: "Shift" }).click(); await audit(page, "shift");
    await page.getByRole("button", { name: /Close register/ }).click(); await audit(page, "close register");
    await page.getByRole("button", { name: "See the difference" }).click(); await audit(page, "close sheet");
  });
});

test.describe("stock on the floor", () => {
  test("a manager receives a transfer (writing off what is missing) and counts the shelf by scanning, on the till", async ({ page }) => {
    const shop = await provisionShop({ stock: 10 }); const tok = shop.ownerToken; const v = shop.variants[0]!;
    const other = (await apiPost(tok, "/locations", { code: `O${shop.tag}`, name: `Depot ${shop.tag}`, type: "warehouse", timezone: "Australia/Melbourne" })).body;
    await apiPost(tok, "/inventory/receive", { locationId: other.id, idempotencyKey: crypto.randomUUID(), lines: [{ variantId: v.id, qty: 30, unitCostMinor: 4000 }] });
    const t = (await apiPost(tok, "/transfers", { fromLocationId: other.id, toLocationId: shop.locationId, lines: [{ variantId: v.id, qty: 6 }] })).body; await apiPost(tok, `/transfers/${t.id}/send`, {});
    const k = (await apiPost(tok, "/stock-counts", { locationId: shop.locationId, mode: "cycle", variantIds: [v.id], blind: true })).body;
    await pairAndOpen(page, shop, shop.manager); await page.getByRole("link", { name: "Stock" }).click();
    await page.getByRole("button", { name: `Open transfer ${t.number}` }).click(); await page.getByRole("button", { name: /^Decrease arrived/ }).click();
    await page.getByRole("radio", { name: /Lost: write off 1/ }).click(); await shot(page, "stock-receive"); await page.getByRole("button", { name: "Record receipt" }).click();
    await expect(page.getByText(`${t.number}: complete, 1 written off.`)).toBeVisible();
    expect(await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [v.id, shop.locationId])).toEqual([{ n: 15 }]);
    await page.getByRole("radio", { name: "Count" }).click(); await page.getByRole("button", { name: `Open count ${k.number}` }).click();
    const scan = page.getByLabel("Scan to count"); for (let i = 0; i < 14; i++) { await scan.fill(v.barcode); await scan.press("Enter"); }
    await expect(page.getByTestId("count-lines")).toContainText(v.sku); await expect(page.getByRole("group", { name: `Counted ${v.sku}` })).toContainText("14"); await shot(page, "stock-count");
    await page.getByRole("button", { name: "Submit count" }).click(); await expect(page.getByText(/Submitted for review/)).toBeVisible();
    expect(await sql(`select c.status, l.counted_qty::int as n, l.expected_at_snapshot::int as e from shelfline.stock_count c join shelfline.stock_count_line l on l.count_id = c.id where c.id = $1`, [k.id])).toEqual([{ status: "review", n: 14, e: 10 }]);
  });
});

test.describe("price books and promotions", () => {
  const setup = async (shop: Shop) => {
    const tok = shop.ownerToken; const v = shop.variants[0]!;
    const b = (await apiPost(tok, "/price-books", { name: `Spring ${shop.tag}`, priority: 50 })).body; await apiPost(tok, `/price-books/${b.id}/entries`, { set: [{ variantId: v.id, priceMinor: 15000 }] }, "PUT");
    const p = (await apiPost(tok, "/promotions", { name: `Ten ${shop.tag}`, kind: "percent", valueBp: 1000, variantIds: [v.id] })).body; return { b, p, v, tok };
  };
  test("the till sells at the book price with the promotion, and the server stores the book and the split without a flag", async ({ page }) => {
    const shop = await provisionShop(); const { b, p, v } = await setup(shop); await pairAndOpen(page, shop);
    await addByBarcode(page, v.barcode); await expect(line(page, "Tempra Glide 3")).toContainText("135.00"); await expect(page.getByTestId("promo-line")).toContainText("Promotion −15.00");   // 150.00 book price less the 10% promotion await shot(page, "pricing-cart");
    await page.getByRole("button", { name: /^Pay A\$135\.00/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click(); await waitSent(page, shop);
    expect(await sql(`select l.unit_price_minor::int as u, l.promo_discount_minor::int as pd, l.discount_minor::int as d, l.price_book_id, l.promotion_ids, l.total_minor::int as t, s.flags from shelfline.sale_line l join shelfline.sale s on s.id = l.sale_id join shelfline.location loc on loc.id = s.location_id where loc.code = $1`, [`S${shop.tag}`]))
      .toEqual([{ u: 15000, pd: 1500, d: 1500, price_book_id: b.id, promotion_ids: [p.id], t: 13500, flags: [] }]);
  });
  test("offline, the till keeps the last synced prices; the late sale is accepted and flagged with both versions, then the till catches up", async ({ page, context }) => {
    const shop = await provisionShop(); const { b, p, v, tok } = await setup(shop); await pairAndOpen(page, shop);
    await expect.poll(() => queued(page)).toBe(0); await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
    await apiPost(tok, `/price-books/${b.id}/entries`, { set: [{ variantId: v.id, priceMinor: 14000 }] }, "PUT"); await apiPost(tok, `/promotions/${p.id}`, { status: "archived" }, "PATCH");       // head office changes prices while the till is offline
    await addByBarcode(page, v.barcode); await expect(line(page, "Tempra Glide 3")).toContainText("135.00"); await expect(page.getByTestId("promo-line")).toBeVisible();
    await page.getByRole("button", { name: /^Pay A\$135\.00/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click(); await expect(page.getByText("Waiting to send")).toBeVisible();
    await context.setOffline(false); await waitSent(page, shop);
    const [s] = await sql(`select s.flags, s.total_minor::int as t, s.price_snapshot from shelfline.sale s join shelfline.location loc on loc.id = s.location_id where loc.code = $1`, [`S${shop.tag}`]);
    expect(s.t).toBe(13500); expect([...s.flags].sort()).toEqual(["price_book_mismatch", "promo_mismatch"]); expect(s.price_snapshot).toMatchObject({ pricingVersion: 2, serverPricingVersion: 3 });
    await page.getByRole("button", { name: "New sale" }).click(); await addByBarcode(page, v.barcode);                    // after the sync the till knows the new book and the retired promotion
    await expect(line(page, "Tempra Glide 3")).toContainText("140.00"); await expect(page.getByTestId("promo-line")).toHaveCount(0);
  });
});

test.describe("gift cards on the till", () => {
  const issueCard = async (shop: Shop, amountMinor: number) => (await apiPost(shop.ownerToken, "/gift-cards", { amountMinor })).body as { id: string; code: string; last4: string };
  const balanceOf = async (shop: Shop, id: string) => ((await (await fetch(`${API}/gift-cards/${id}`, { headers: { authorization: `Bearer ${shop.ownerToken}` } })).json()) as { balanceMinor: number }).balanceMinor;
  test("check a card, pay with it, and the server takes exactly that from it; the receipt shows only the last four", async ({ page }) => {
    const shop = await provisionShop(); const g = await issueCard(shop, 5000); await pairAndOpen(page, shop); await addByBarcode(page, shop.variants[2]!.barcode);
    await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("radio", { name: "Gift card" }).click();
    await page.getByLabel("Gift card code").fill("NOPE-NOPE-NOPE-NOPE"); await page.getByRole("button", { name: "Check card" }).click(); await expect(page.getByTestId("gift-msg")).toContainText("not found");
    await page.getByLabel("Gift card code").fill(g.code.toLowerCase()); await page.getByRole("button", { name: "Check card" }).click(); await expect(page.getByTestId("gift-balance")).toHaveText("A$50.00"); await shot(page, "gift-tender");
    await page.getByRole("button", { name: "Use A$34.00" }).click(); await expect(page.getByTestId("tender-line")).toContainText(`Gift card …${g.last4}`); await expect(page.getByTestId("tender-line")).not.toContainText(g.code);
    await page.getByRole("button", { name: "Complete sale" }).click(); await expect(page.getByText(`Gift card …${g.last4}`).first()).toBeVisible(); await waitSent(page, shop);
    expect(await balanceOf(shop, g.id)).toBe(1600); expect(await sql(`select p.tender, p.reference, s.flags from shelfline.payment p join shelfline.sale s on s.id = p.sale_id join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`])).toEqual([{ tender: "gift_card", reference: `Card …${g.last4}`, flags: [] }]);
  });
  test("a store that allows it takes a gift card offline up to its cap, once per card on this iPad; the server reconciles when the iPad is back", async ({ page, context }) => {
    const shop = await provisionShop(); const g = await issueCard(shop, 10000);
    expect((await apiPost(shop.ownerToken, `/locations/${shop.locationId}`, { giftCardOffline: true, giftCardOfflineCapMinor: 2500 }, "PATCH")).status).toBe(200);
    await pairAndOpen(page, shop); await expect.poll(() => queued(page)).toBe(0); await page.evaluate(() => navigator.serviceWorker.ready); await context.setOffline(true);
    await addByBarcode(page, shop.variants[2]!.barcode); await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("radio", { name: "Gift card" }).click();
    await page.getByLabel("Gift card code").fill(g.code); await page.getByRole("button", { name: "Check card" }).click(); await expect(page.getByTestId("gift-msg")).toContainText("up to A$25.00"); await shot(page, "gift-offline");
    await page.getByRole("button", { name: "Use A$25.00 without checking" }).click(); await page.getByRole("radio", { name: "Cash" }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click(); await expect(page.getByText("Waiting to send")).toBeVisible();
    await page.getByRole("button", { name: "New sale" }).click(); await addByBarcode(page, shop.variants[2]!.barcode); await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("radio", { name: "Gift card" }).click();
    await page.getByLabel("Gift card code").fill(g.code); await page.getByRole("button", { name: "Check card" }).click(); await page.getByRole("button", { name: "Use A$25.00 without checking" }).click(); await expect(page.getByTestId("gift-msg")).toContainText("already used offline on this iPad");
    await context.setOffline(false); await waitSent(page, shop, 1); expect(await balanceOf(shop, g.id)).toBe(7500);
    expect(await sql(`select s.flags from shelfline.sale s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`])).toEqual([{ flags: [] }]);
  });
});

test.describe("my roster on the till", () => {
  test("the Shift screen shows my published shifts in the store's clock, and what I have worked this week", async ({ page }) => {
    const shop = await provisionShop(); const tok = shop.ownerToken;
    const users = (await (await fetch(`${API}/users`, { headers: { authorization: `Bearer ${tok}` } })).json()) as { id: string; name: string }[]; const me = users.find((u) => u.name === shop.cashier.name)!;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect((await apiPost(tok, "/shifts", { locationId: shop.locationId, userId: me.id, date: today, start: "09:00", end: "17:00", role: "Floor", breakMinutes: 30 })).status).toBe(201);
    await apiPost(tok, "/shifts", { locationId: shop.locationId, userId: me.id, date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), start: "10:00", end: "14:00" });          // a draft stays hidden
    expect((await apiPost(tok, "/shifts/publish", { locationId: shop.locationId, from: today, to: today })).body).toEqual({ published: 1 });
    await pairAndOpen(page, shop); await page.getByRole("link", { name: "Shift" }).click();
    const r = page.getByTestId("my-roster"); await expect(r).toContainText("My shifts"); await expect(r).toContainText("09:00–17:00"); await expect(r).toContainText("Floor"); await expect(r).not.toContainText("10:00–14:00"); await shot(page, "my-roster");
    await page.getByRole("button", { name: "Clock in" }).click(); await expect(page.getByTestId("clock-state")).toContainText("Clocked in");
    await expect.poll(async () => (await sql(`select count(*)::int as n from shelfline.punch p join shelfline.location l on l.id = p.location_id where l.code = $1`, [`S${shop.tag}`]))[0].n).toBe(1);
  });
});

test.describe("fingerprint terminal punches on the till", () => {
  test("a clock-in from the terminal shows on the Shift screen, with where it came from, and the till then offers Clock out", async ({ page }) => {
    const shop = await provisionShop(); const tok = shop.ownerToken; const { createHmac } = await import("node:crypto");
    await apiPost(tok, "/terminals", { locationId: shop.locationId, serial: `T${shop.tag}`, name: "Staff door" }); const b = (await apiPost(tok, "/bridges", { locationId: shop.locationId, name: "Back office" })).body;
    const p = (await (await fetch(`${API}/devices/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingCode: b.pairingCode }) })).json()) as { bridgeId: string; secret: string };
    await pairAndOpen(page, shop); await page.getByRole("link", { name: "Shift" }).click(); await expect(page.getByTestId("clock-state")).toContainText("No punch yet");
    const body = JSON.stringify({ events: [{ serial: `T${shop.tag}`, personCode: shop.cashier.code, ts: new Date(Date.now() - 60_000).toISOString(), verify: "fingerprint" }] }); const ts = String(Math.floor(Date.now() / 1000));
    const r = await fetch(`${API}/devices/punches`, { method: "POST", headers: { "content-type": "application/json", "x-bridge-id": p.bridgeId, "x-timestamp": ts, "x-signature": createHmac("sha256", p.secret).update(`${ts}.${body}`).digest("hex") }, body }); expect((await r.json()).results).toEqual([{ status: "accepted" }]);
    await page.getByRole("link", { name: "Sell" }).click(); await page.getByRole("link", { name: "Shift" }).click();                         // the screen asks the server when it opens
    await expect(page.getByTestId("clock-state")).toContainText("Clocked in"); await expect(page.getByTestId("clock-state")).toContainText("fingerprint terminal Staff door");
    await expect(page.getByRole("button", { name: "Clock in" })).toBeDisabled(); await expect(page.getByRole("button", { name: "Clock out" })).toBeEnabled(); await shot(page, "terminal-clocked-in");
  });
});

test.describe("printer, drawer and scanner", () => {
  const printerFor = (shop: Shop) => apiPost(shop.ownerToken, "/printers", { locationId: shop.locationId, name: "Front desk", host: "192.168.1.50" });
  const jobs = (shop: Shop) => sql(`select j.kind, j.status, j.copy, j.payload_base64 from shelfline.print_job j join shelfline.location l on l.id = j.location_id where l.code = $1 order by j.created_at`, [`S${shop.tag}`]);
  test("a cash sale opens the drawer, the receipt prints on request and a second request is a copy; no printer says so plainly", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addByBarcode(page, shop.variants[2]!.barcode); await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await waitSent(page, shop); await page.getByRole("button", { name: "Print receipt" }).click(); await expect(page.getByRole("status").filter({ hasText: "No printer is set up" })).toBeVisible(); await shot(page, "print-no-printer");
    expect((await printerFor(shop)).status).toBe(201);
    await page.getByRole("button", { name: "Print receipt" }).click(); await expect(page.getByText("Sent to Front desk.")).toBeVisible(); await page.getByRole("button", { name: "Print receipt" }).click(); await expect(page.getByText("Sent to Front desk (copy 2).")).toBeVisible(); await shot(page, "print-sent");
    const js = await jobs(shop); expect(js.map((j: any) => `${j.kind}:${j.copy}`)).toEqual(["receipt:1", "receipt:2"]); const text = Buffer.from(js[1]!.payload_base64, "base64").toString("latin1"); expect(text).toContain("*** COPY 2 ***"); expect(text).toContain("Crew socks 2-pack"); expect(text).toContain("34.00");
    // a second cash sale, now that there is a printer: the drawer kick is queued without anyone asking
    await page.getByRole("button", { name: "New sale" }).click(); await addByBarcode(page, shop.variants[2]!.barcode); await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
    await expect.poll(async () => (await jobs(shop)).filter((j: any) => j.kind === "drawer").length, { timeout: 15_000 }).toBe(1);
  });
  test("a scan is added wherever the focus is, a person typing is not mistaken for one, and an unknown code is reported", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop); const away = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());     // focus on nothing: not in the search box
    await away(); await page.keyboard.type(shop.variants[1]!.barcode, { delay: 5 }); await page.keyboard.press("Enter");                                                 // fast, ending in Enter: a scanner
    await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByTestId("cart-line").first()).toContainText(shop.variants[1]!.title);
    await away(); await page.keyboard.type("9999999999999", { delay: 5 }); await page.keyboard.press("Enter"); await expect(page.getByText("Nothing found for “9999999999999”")).toBeVisible(); await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await away(); await page.keyboard.type(shop.variants[2]!.barcode, { delay: 250 }); await page.keyboard.press("Enter");                                              // slow: a person, not a scanner
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await page.getByLabel("Scan barcode or search products").fill(shop.variants[2]!.barcode); await page.getByLabel("Scan barcode or search products").press("Enter"); await expect(page.getByTestId("cart-line")).toHaveCount(2);   // the search box still works as before
  });
});

test.describe("card terminal", () => {
  const readerFor = (shop: Shop) => apiPost(shop.ownerToken, "/card-readers", { locationId: shop.locationId, name: "Counter terminal", providerReaderId: "tmr_SIM1" });
  test("the amount goes to the terminal, an approval becomes the card tender and the sale is tied to it; with no terminal it says so and the manual way remains", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await addByBarcode(page, shop.variants[2]!.barcode); await page.getByRole("button", { name: /^Pay A\$34\.00/ }).click(); await page.getByRole("radio", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: /Charge A\$34\.00 on the card terminal/ }).click(); await expect(page.getByTestId("card-msg")).toContainText("No card terminal is set up"); await expect(page.getByLabel("Reference (optional)")).toBeVisible(); await shot(page, "card-no-terminal");
    expect((await readerFor(shop)).status).toBe(201);
    await page.getByRole("button", { name: /Charge A\$34\.00 on the card terminal/ }).click(); await expect(page.getByTestId("card-terminal")).toContainText("Waiting for the customer"); await shot(page, "card-waiting");
    await expect(page.getByTestId("tender-line")).toHaveCount(1, { timeout: 15_000 }); await expect(page.getByTestId("tender-line").first()).toContainText("Card"); await expect(page.getByTestId("tender-line").first()).toContainText("····4242");
    await page.getByRole("button", { name: "Complete sale" }).click(); await waitSent(page, shop);
    const [cp] = await sql(`select cp.status, cp.sale_id, cp.amount_minor::int as a from shelfline.card_payment cp join shelfline.location l on l.id = cp.location_id where l.code = $1`, [`S${shop.tag}`]); expect(cp).toMatchObject({ status: "succeeded", a: 3400 }); expect(cp.sale_id).toBeTruthy();
  });
});

test.describe("online pickup", () => {
  test("a customer's pickup code loads their order into a sale; paying completes it and the order is collected, with the goods taken out once", async ({ page }) => {
    const shop = await provisionShop({ stock: 5 }); await pairAndOpen(page, shop);
    expect((await apiPost(shop.ownerToken, `/locations/${shop.locationId}`, { pickupEnabled: true }, "PATCH")).status).toBe(200);
    const org = (await (await fetch(`${API}/shop-default`)).json()) as { orgId: string };
    const placed = await fetch(`${API}/shop/${org.orgId}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `cust.${shop.tag}@example.com`, name: "Pat Pickup", locationId: shop.locationId, lines: [{ variantId: shop.variants[2]!.id, qty: 2 }] }) }); expect(placed.status).toBe(201); const order = (await placed.json()) as { pickupCode: string; id: string };
    const onHand = async () => Number((await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1`, [shop.variants[2]!.id]))[0]!.n); expect(await onHand()).toBe(3);                     // 5, less the 2 held for Pat
    await page.getByRole("button", { name: "Online pickup" }).click(); await page.getByLabel("Pickup code").fill("ZZZZZZ"); await page.getByRole("button", { name: "Find order" }).click(); await expect(page.getByRole("alert")).toContainText("No open order has that code at this store");
    await page.getByLabel("Pickup code").fill(order.pickupCode.toLowerCase()); await page.getByRole("button", { name: "Find order" }).click(); const found = page.getByTestId("pickup-order"); await expect(found).toContainText("Pat Pickup"); await expect(found).toContainText("2 × Crew socks 2-pack"); await shot(page, "pickup-found");
    await page.getByRole("button", { name: "Load into sale" }).click(); await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByTestId("cart-total")).toHaveText("A$68.00"); await expect(page.getByText(/loaded for Pat Pickup/)).toBeVisible();
    await page.getByRole("button", { name: /^Pay A\$68\.00/ }).click(); await page.getByRole("button", { name: "Exact" }).click(); await page.getByRole("button", { name: "Complete sale" }).click(); await waitSent(page, shop);
    await expect.poll(async () => (await sql(`select status from shelfline.online_order where id = $1`, [order.id]))[0]!.status, { timeout: 20_000 }).toBe("collected"); expect(await onHand()).toBe(3);                      // taken out by the sale, not twice
    const [o] = await sql(`select o.sale_id, s.total_minor::int as t from shelfline.online_order o join shelfline.sale s on s.id = o.sale_id where o.id = $1`, [order.id]); expect(o.t).toBe(6800);
    await page.getByRole("button", { name: "New sale" }).click(); await page.getByRole("button", { name: "Online pickup" }).click(); await page.getByLabel("Pickup code").fill(order.pickupCode); await page.getByRole("button", { name: "Find order" }).click(); await expect(page.getByRole("alert")).toContainText("No open order");
  });
});
