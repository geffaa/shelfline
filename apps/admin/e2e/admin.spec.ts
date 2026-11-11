import { expect, test, type Page } from "@playwright/test";
import { generate } from "otplib";
import { FakeIdp } from "../../api/test-support/fake-idp";
import { API, cashMove, closeSession, cmd, http, lens, openSession, OWNER, ownerToken, provisionWorld, push, sell, signIn, sql, type World } from "./fixtures";

const go = async (page: Page, domain: string, sub?: string) => {
  await page.getByRole("navigation", { name: "Domains" }).first().getByRole("link", { name: domain, exact: true }).click();
  if (sub) await page.getByRole("navigation", { name: `${domain} pages` }).getByRole("link", { name: sub, exact: true }).click();
};
const shot = (page: Page, name: string) => page.screenshot({ path: `../../.impeccable/review/admin-${name}.png` });
let w: World;

test.describe("sign in", () => {
  test("wrong password is refused; the right one opens the shell; a two-step account asks for its code", async ({ page }) => {
    w = await provisionWorld();
    await page.goto("/"); await page.getByLabel("Email").fill(OWNER.email); await page.getByLabel("Password").fill("not-the-password"); await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("do not match");
    await signIn(page); await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    // two-step: enable TOTP on the manager through the API, then sign in with a code
    const mgrTok = (await http("POST", "/auth/login", null, { email: w.manager.email, password: w.manager.password })).body.token;
    const secret = (await http("POST", "/auth/totp/setup", mgrTok)).body.secret; expect((await http("POST", "/auth/totp/enable", mgrTok, { code: await generate({ secret }) })).status).toBe(204);
    await page.getByRole("button", { name: "Account menu" }).click(); await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.getByLabel("Email").fill(w.manager.email); await page.getByLabel("Password").fill(w.manager.password); await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Two-step check" })).toBeVisible();
    await page.getByLabel(/6-digit code/).fill("000000"); await page.getByRole("button", { name: "Verify" }).click(); await expect(page.getByRole("alert")).toContainText("not right");
    await page.getByLabel(/6-digit code/).fill(await generate({ secret })); await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  });
});

test.describe("Today (live) and the location lens", () => {
  test("a sale made on a till appears on Today within two seconds, without a refresh; the lens limits the numbers; a manager sees only their store", async ({ page, browser }) => {
    w = await provisionWorld(); const [a, b] = w.stores as [typeof w.stores[0], typeof w.stores[0]];
    await openSession(a, w); await openSession(b, w);
    await signIn(page); await lens(page, new RegExp(a.name)).click();
    await expect(page.getByTestId("live-chip")).toContainText("Live", { timeout: 15_000 });
    await expect(page.getByText("No sales yet today")).toBeVisible();
    await sell(a, w, [{ v: 0, qty: 1 }], "cash");
    await expect(page.getByTestId("net-sales")).toHaveText("219.95", { timeout: 2500 });
    await expect(page.getByTestId("orders-count")).toHaveText("1");
    await sell(a, w, [{ v: 1, qty: 2, discount: 890 }], "card");
    await expect(page.getByTestId("net-sales")).toHaveText("389.05", { timeout: 2500 }); await expect(page.getByTestId("orders-count")).toHaveText("2");
    await expect(page.getByRole("table", { name: "Registers" }).or(page.getByText(a.regCode))).toBeVisible();
    await shot(page, "today");
    // another store, another number
    await sell(b, w, [{ v: 2, qty: 1 }], "cash");
    await lens(page, new RegExp(b.name)).click(); await expect(page.getByTestId("net-sales")).toHaveText("34.00");
    await lens(page, new RegExp(a.name)).click(); await expect(page.getByTestId("net-sales")).toHaveText("389.05");
    // the store manager of store A: the rail has only that store, and "All locations" equals store A
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const mp = await ctx.newPage();
    await mp.goto("/"); await mp.getByLabel("Email").fill(w.manager.email); await mp.getByLabel("Password").fill(w.manager.password); await mp.getByRole("button", { name: "Sign in" }).click();
    const rail = mp.getByRole("complementary", { name: "Locations" }); await expect(rail.getByRole("button")).toHaveCount(2);        // All + their store
    await expect(rail.getByRole("button", { name: new RegExp(b.name) })).toHaveCount(0);
    await expect(mp.getByTestId("net-sales")).toHaveText("389.05");
    await mp.getByRole("link", { name: "Admin settings" }).click(); await expect(mp.getByRole("navigation", { name: "Admin pages" })).toHaveCount(0);   // locations only: no audit log for a store manager
    await ctx.close();
  });
});

test.describe("orders and alerts", () => {
  test("flagged orders can be found, opened and explained; the alert can be resolved; search by receipt from the top bar", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w);
    await sell(a, w, [{ v: 0, qty: 1 }], "cash", { receiptNo: "E2E-000111" });
    await sell(a, w, [{ v: 2, qty: 1 }], "card", { receiptNo: "E2E-000222", tamper: 1 });             // total off by one cent -> price_mismatch + payment ok
    await sell(a, w, [{ v: 1, qty: 30 }], "card", { receiptNo: "E2E-000333" });                         // more than the 20 in stock -> negative_stock
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Sell", "Orders");
    await expect(page.getByTestId("orders-table").getByRole("row")).toHaveCount(4);                     // header + 3
    await page.getByRole("combobox", { name: "Alert" }).click(); await page.getByRole("option", { name: "Stock below zero" }).click();
    await expect(page.getByTestId("orders-table").getByRole("row")).toHaveCount(2);
    await page.getByTestId("orders-table").getByText("E2E-000333").click();
    const d = page.getByTestId("order-detail"); await expect(d).toContainText("Recorded with notes"); await expect(d).toContainText("Stock below zero"); await expect(d).toContainText("30"); await shot(page, "order");
    // alerts
    await go(page, "Today", "Alerts"); const alerts = page.getByTestId("alerts-table"); await expect(alerts).toContainText("Stock below zero"); await expect(alerts).toContainText("E2E-000333");
    const before = await alerts.getByRole("row").count(); await alerts.getByRole("button", { name: "Resolve" }).first().click();
    await expect(alerts.getByRole("row")).toHaveCount(before - 1);
    // top-bar search
    await page.getByRole("search").getByLabel(/Search orders/).fill("E2E-000111"); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible(); await expect(page.getByTestId("orders-table").getByText("E2E-000111")).toBeVisible();
  });
});

test.describe("registers and sessions", () => {
  test("a closed register shows its close sheet, variance and what happened; it can be reviewed; the date picker works from the keyboard", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const sid = await openSession(a, w, 30000);
    await sell(a, w, [{ v: 0, qty: 1 }], "cash"); await cashMove(a, w, "pay_out", 3200, "Courier"); await cashMove(a, w, "no_sale", 0);
    await closeSession(a, w, 47795);                                                                  // expected 30000 + 21995 - 3200 = 48795: 10.00 short
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Today", "Registers & sessions");
    const row = page.getByTestId("sessions-table").getByRole("row").filter({ hasText: a.regCode }); await expect(row).toContainText("−10.00"); await expect(row).toContainText("Needs review");
    // times are the store's clock (Melbourne), not the browser's (this browser runs in Auckland)
    const [o] = await sql(`select opened_at from shelfline.register_session where id = $1`, [sid]);
    const melb = new Date(o.opened_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Australia/Melbourne" });
    await expect(row.locator("td.mono")).toContainText(melb);
    await row.click(); await expect(page.getByTestId("variance")).toHaveText("−10.00");
    await expect(page.getByText("Expected in drawer")).toBeVisible(); await expect(page.getByText("No sale").first()).toBeVisible(); await expect(page.getByText("No-sale without a reason")).toBeVisible(); await shot(page, "session");
    await page.getByLabel("Review note").fill("Recounted: one note short"); await page.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.getByText("Recounted: one note short")).toBeVisible(); await expect(row).toContainText("Reviewed");
    // keyboard date picker
    const picker = page.getByRole("button", { name: /^Business day:/ }); const was = await picker.getAttribute("aria-label");
    await picker.click(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Enter");
    expect(await picker.getAttribute("aria-label")).not.toBe(was); await expect(page.getByText("No register sessions on this day")).toBeVisible();
    expect(sid).toBeTruthy();
  });
});

test.describe("products and the audit log", () => {
  test("create a product, change a price (audited with before and after), refuse a duplicate SKU, import a CSV with one bad row", async ({ page }) => {
    w = await provisionWorld(); const tag = w.stores[0]!.tag;
    await signIn(page); await go(page, "Stock", "Products");
    await page.getByRole("button", { name: "New product" }).click();
    await page.getByLabel("Title").fill(`Ridge Trail ${tag}`); await page.getByRole("combobox", { name: "Tax class" }).click(); await page.getByRole("option", { name: "GST" }).click();
    await page.getByLabel("SKU 1").fill(`RT-${tag}-9`); await page.getByLabel("Price 1").fill("189.95"); await page.getByLabel("Size 1").fill("9");
    await page.getByRole("button", { name: "Create product" }).click();
    const vt = page.getByTestId("variants-table"); await expect(vt).toContainText("189.95");
    await vt.getByRole("button", { name: "Edit" }).click(); await vt.getByLabel(`Price for RT-${tag}-9`).fill("199.95"); await vt.getByRole("button", { name: "Save" }).click(); await expect(vt).toContainText("199.95");
    await page.getByRole("button", { name: "Add variant" }).click(); await page.getByLabel("New variant SKU").fill(`RT-${tag}-9`); await page.getByLabel("New variant price").fill("10"); await page.getByRole("button", { name: "Add variant" }).last().click();
    await expect(page.getByRole("alert")).toContainText("SKU already exists");
    // CSV import: one good row, one with a bad price
    await page.getByRole("button", { name: "Import CSV" }).click();
    const csv = `product_title,brand,category,tax_class,sku,barcode,price,cost,option_size,option_colour\nCSV Shoe ${tag},Tempra,Running shoes,gst,CSV-${tag}-1,,120.00,,9,Black\nCSV Shoe ${tag},Tempra,Running shoes,gst,CSV-${tag}-2,,twelve,,10,Black\n`;
    await page.locator("input[type=file]").setInputFiles({ name: "products.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await page.getByRole("button", { name: "Check the file" }).click(); await expect(page.getByTestId("import-report")).toContainText("1 variant"); await expect(page.getByText("Line 3:")).toContainText("price");
    await page.getByRole("button", { name: "Import", exact: true }).click(); await expect(page.getByTestId("import-report")).toContainText("Imported:");
    await expect.poll(async () => (await sql(`select count(*)::int as n from shelfline.variant where sku = $1`, [`CSV-${tag}-1`]))[0]!.n).toBe(1);
    // audit
    await go(page, "Sell"); await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "Audit log" }).click();
    await page.getByRole("combobox", { name: "Action" }).click(); await page.getByRole("option", { name: "variant.price_change" }).click();
    const t = page.getByTestId("audit-table"); await expect(t).toContainText("Owner"); await t.getByText("Details").first().click(); await expect(t.getByText("18995").first()).toBeVisible(); await expect(t.getByText("19995").first()).toBeVisible(); await shot(page, "audit");
  });
});

test.describe("inventory", () => {
  test("the stock matrix, the stock card with its running balance, an adjustment that cannot go below zero, and a receipt", async ({ page }) => {
    w = await provisionWorld({ stores: 2, stock: 10 }); const a = w.stores[0]!;
    await openSession(a, w); await sell(a, w, [{ v: 0, qty: 12 }], "card");                           // 10 in stock, sold 12: -2
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Stock", "Inventory");
    await page.getByLabel("Search inventory").fill(a.variants[0]!.sku);
    await page.getByRole("button", { name: new RegExp(`${a.variants[0]!.sku} at ${a.name}: -?\\d+ on hand`) }).click();
    const card = page.getByRole("region", { name: "Stock card" }); await expect(card.getByTestId("on-hand")).toHaveText("-2"); await expect(card).toContainText("Stock below zero"); await expect(card.getByTestId("stock-card")).toContainText("Received");
    await card.getByRole("button", { name: `Adjust stock at ${a.name}` }).click();
    await card.getByRole("button", { name: "Increase change in stock" }).click(); await card.getByRole("button", { name: "Increase change in stock" }).click();   // -1 -> +1
    await card.getByRole("combobox", { name: "Reason" }).click(); await page.getByRole("option", { name: "Found" }).click(); await card.getByRole("button", { name: "Save adjustment" }).click();
    await expect(card.getByTestId("on-hand")).toHaveText("-1");
    await card.getByRole("button", { name: `Adjust stock at ${a.name}` }).click(); for (let i = 0; i < 4; i++) await card.getByRole("button", { name: "Decrease change in stock" }).click();
    await card.getByRole("combobox", { name: "Reason" }).click(); await page.getByRole("option", { name: "Damaged in store" }).click(); await card.getByRole("button", { name: "Save adjustment" }).click();
    await expect(card.getByRole("alert")).toContainText("cannot take stock below zero"); await card.getByRole("button", { name: "Cancel" }).click();
    await card.getByRole("button", { name: "Receive stock" }).click(); await card.getByLabel("Cost per unit").fill("118.40"); await card.getByRole("button", { name: "Receive", exact: true }).click();
    await expect(card.getByTestId("on-hand")).toHaveText("0"); await shot(page, "inventory");
    const [mv] = await sql(`select count(*)::int as n from shelfline.stock_movement m join shelfline.variant v on v.id = m.variant_id where v.sku = $1 and m.location_id = $2`, [a.variants[0]!.sku, a.id]); expect(mv.n).toBe(4);   // receive, sale, adjust, receive
  });
});

test.describe("people and locations", () => {
  test("add a person with a role at one location, change the role, set a PIN; the last owner cannot be demoted; disable", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const email = `new.${a.tag.toLowerCase()}@e2e.test`;
    await signIn(page); await go(page, "People"); await page.getByRole("button", { name: "New person" }).click();
    await page.getByLabel("Name").fill(`Jun ${a.tag}`); await page.getByLabel("Email").fill(email); await page.getByLabel("Employee code").fill(`J${a.tag}`); await page.getByLabel("Till PIN").fill("2468");
    await page.getByRole("combobox", { name: "Location 1" }).click(); await page.getByRole("option", { name: a.name }).click();
    await page.getByRole("button", { name: "Create person" }).click();
    await expect(page.getByRole("region", { name: `Jun ${a.tag}` })).toBeVisible();
    const detail = page.getByRole("region", { name: `Jun ${a.tag}` });
    await detail.getByRole("combobox", { name: "Role 1" }).click(); await page.getByRole("option", { name: "Store manager" }).click(); await detail.getByRole("button", { name: "Save roles" }).click(); await expect(detail.getByText("Roles saved")).toBeVisible();
    expect((await sql(`select r.key from shelfline.user_assignment ua join shelfline.role r on r.id = ua.role_id join shelfline."user" u on u.id = ua.user_id where u.email = $1`, [email]))).toEqual([{ key: "store_manager" }]);
    await detail.getByLabel("New PIN").fill("1357"); await detail.getByRole("button", { name: "Set PIN" }).click(); await expect(detail.getByText("PIN set")).toBeVisible();
    // the owner cannot remove their own last owner role
    await page.getByTestId("staff-table").getByText("Owner").first().click(); const me = page.getByRole("region", { name: "Owner" });
    await me.getByRole("button", { name: "Remove assignment 1" }).click(); await me.getByRole("button", { name: "Save roles" }).click(); await expect(me.getByRole("alert")).toContainText("without an owner");
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("staff-table").getByText(`Jun ${a.tag}`).click(); await detail.getByRole("button", { name: "Disable this person" }).click();
    await expect(page.getByTestId("staff-table").getByRole("row").filter({ hasText: `Jun ${a.tag}` })).toContainText("Disabled");
  });

  test("create a location, add a register and a POS device (the key is shown once), set the till's limits, and a store with an open register cannot be switched off", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w); const code = `N${a.tag}`;
    await signIn(page); await page.getByRole("link", { name: "Admin settings" }).click();
    await page.getByRole("button", { name: "New location" }).click(); await page.getByLabel("Code").fill(code); await page.getByLabel("Name", { exact: true }).fill(`Fremantle ${a.tag}`); await page.getByRole("button", { name: "Perth" }).click(); await page.getByRole("button", { name: "Create location" }).click();
    const d = page.getByRole("region", { name: `Fremantle ${a.tag}` }); await expect(d).toBeVisible(); await expect(d.getByLabel("Time zone")).toHaveValue("Australia/Perth");
    await page.getByLabel("Register code").fill(`${code}-1`); await page.getByLabel("Register name").fill("Front desk"); await page.getByRole("button", { name: "Add register" }).click(); await expect(page.getByText(`${code}-1`).first()).toBeVisible();
    await page.getByLabel("Device name").fill(`iPad ${code}`); await page.getByRole("combobox", { name: "Register" }).click(); await page.getByRole("option", { name: `${code}-1` }).click(); await page.getByRole("button", { name: "Add POS device" }).click();
    await expect(page.getByTestId("device-key")).toContainText(/^slk_/); await page.getByRole("button", { name: "I have saved it" }).click(); await expect(page.getByTestId("device-key")).toHaveCount(0);
    await d.getByLabel("Refund a cashier may give (A$)").fill("50.00"); await d.getByRole("button", { name: "Save changes" }).click(); await expect(d.getByText("Saved.")).toBeVisible();
    expect((await sql(`select cashier_refund_limit_minor as n from shelfline.location where code = $1`, [code]))[0]!.n).toBe(5000);
    // the first store has an open register
    await page.getByTestId("locations-table").getByText(a.name).click(); const r = page.getByRole("region", { name: a.name }); await r.getByRole("switch", { name: "Location is active" }).click(); await r.getByRole("button", { name: "Save changes" }).click();
    await expect(r.getByRole("alert")).toContainText("register is still open");
  });
});

test.describe("reports", () => {
  test("sales by day, location and product add up; the CSV downloads", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w);
    await sell(a, w, [{ v: 0, qty: 1 }], "cash"); await sell(a, w, [{ v: 1, qty: 2, discount: 890 }], "card");
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Money", "Reports");
    await page.getByRole("button", { name: "Today", exact: true }).click(); await expect(page.getByTestId("report-net")).toHaveText("389.05");
    await page.getByRole("radio", { name: "Product" }).click(); await expect(page.getByTestId("report-table")).toContainText(`Tempra Glide 3 ${a.tag}`); await expect(page.getByTestId("report-net")).toHaveText("389.05");
    await page.getByRole("radio", { name: "Location" }).click(); await expect(page.getByTestId("report-table")).toContainText(a.name);
    const dl = page.waitForEvent("download"); await page.getByRole("button", { name: "Download CSV" }).click(); const f = await dl; expect(f.suggestedFilename()).toMatch(/^sales-location-/);
    const text = await (await import("node:fs/promises")).readFile((await f.path())!, "utf8"); expect(text).toContain("label,orders,items,gross,discounts,refunds,net,gst_included"); expect(text).toContain(`${a.name},2,3,389.05,8.90,0.00,389.05`);
    await shot(page, "reports");
  });
});

test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("the shell collapses to a location chip and bottom tabs, and no page scrolls sideways", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w); await sell(a, w, [{ v: 0, qty: 1 }], "cash");
    await signIn(page);
    await expect(page.getByRole("button", { name: "Choose location" })).toBeVisible(); await expect(page.getByRole("navigation", { name: "Domains" }).last()).toBeVisible();
    const overflow = async (label: string) => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), label).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Choose location" }).click(); await page.getByRole("dialog", { name: "Choose location" }).getByRole("button", { name: new RegExp(a.name) }).click();
    await expect(page.getByTestId("net-sales")).toHaveText("219.95"); await overflow("today"); await shot(page, "today-mobile");
    for (const d of ["Sell", "Stock", "People", "Money"]) { await page.getByRole("navigation", { name: "Domains" }).last().getByRole("link", { name: d, exact: true }).click(); await expect(page.locator("main h1")).toBeVisible(); await overflow(d); }
    await page.getByRole("navigation", { name: "Domains" }).last().getByRole("link", { name: "Sell", exact: true }).click(); await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible(); await shot(page, "orders-mobile");
  });
});
void API;

test.describe("purchasing and supplier bills", () => {
  test("raise a purchase order, receive part of it with freight: stock and cost move, the order stays open for the rest", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const v = a.variants[0]!;
    const sup = (await http("POST", "/suppliers", w.owner, { name: `Tempra ${a.tag}`, termsDays: 14 })).body;
    await signIn(page); await go(page, "Stock", "Purchase orders"); await page.getByRole("button", { name: "New order" }).click();
    await page.getByRole("combobox", { name: "Supplier" }).click(); await page.getByRole("option", { name: sup.name }).click();
    await page.getByRole("combobox", { name: "Deliver to" }).click(); await page.getByRole("option", { name: a.name }).click();
    await page.getByLabel("Add a product").fill(v.sku); await page.getByRole("option").first().click();
    const lines = page.getByTestId("po-lines"); for (let i = 0; i < 9; i++) await lines.getByRole("button", { name: /^Increase quantity/ }).click();
    await lines.getByLabel(/^Unit cost of/).fill("50.00"); await shot(page, "po-new"); await page.getByRole("button", { name: "Save and send" }).click();
    const detail = page.getByTestId("po-detail"); await expect(detail).toContainText("Sent"); await expect(detail.getByTestId("po-line-table")).toContainText("10");
    const before = await sql(`select coalesce(b.on_hand, 0)::int as n from shelfline.variant v left join shelfline.stock_balance b on b.variant_id = v.id and b.location_id = $2 where v.id = $1`, [v.id, a.id]);
    await detail.getByRole("button", { name: "Receive goods" }).click(); const rc = page.getByRole("form", { name: "Receive goods" });
    for (let i = 0; i < 6; i++) await rc.getByRole("button", { name: /^Decrease received/ }).click();
    await rc.getByLabel("Freight (A$)").fill("10.00"); await shot(page, "po-receive"); await rc.getByRole("button", { name: "Record delivery" }).click();
    await expect(detail).toContainText("recorded"); await expect(detail).toContainText("Freight was added to the unit costs"); await detail.getByRole("button", { name: "Done" }).click();
    await expect(detail).toContainText("Part received"); await expect(page.getByTestId("po-table").getByRole("row").filter({ hasText: sup.name })).toContainText("4 / 10");
    const after = await sql(`select b.on_hand::int as n, b.avg_cost_minor::int as avg from shelfline.stock_balance b where b.variant_id = $1 and b.location_id = $2`, [v.id, a.id]);
    expect(after[0].n - before[0].n).toBe(4);
    const lastIn = await sql(`select unit_cost_minor::int as c from shelfline.stock_movement where variant_id = $1 and kind = 'receive_po'`, [v.id]); expect(lastIn).toEqual([{ c: 5250 }]);   // (4 x 50.00 + 10.00 freight) / 4
    await expect(detail.getByRole("button", { name: "Close, no more coming" })).toBeVisible(); await shot(page, "po-partial");
  });

  test("a bill for more than was received is held and cannot be paid; receiving the rest releases it; it is then paid in full and leaves the aging table", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const v = a.variants[0]!; const tok = w.owner;
    const sup = (await http("POST", "/suppliers", tok, { name: `Valk ${a.tag}`, termsDays: 30 })).body;
    const po = (await http("POST", "/purchase-orders", tok, { supplierId: sup.id, locationId: a.id, lines: [{ variantId: v.id, qty: 60, unitCostMinor: 5000 }] })).body; await http("POST", `/purchase-orders/${po.id}/send`, tok);
    const line = (await http("GET", `/purchase-orders/${po.id}`, tok)).body.lines[0];
    expect((await http("POST", `/purchase-orders/${po.id}/receive`, tok, { idempotencyKey: crypto.randomUUID(), lines: [{ poLineId: line.id, qty: 40 }] })).status).toBe(200);
    const bill = (await http("POST", "/bills", tok, { supplierId: sup.id, poId: po.id, number: `INV-${a.tag}`, billDate: new Date().toISOString().slice(0, 10), lines: [{ poLineId: line.id, variantId: v.id, qty: 60, unitCostMinor: 5000 }] })).body; expect(bill.status).toBe("held");
    await signIn(page); await go(page, "Money", "Bills & payments");
    await expect(page.getByTestId("aging-table")).toContainText(sup.name); await expect(page.getByTestId("aging-table").getByRole("row").filter({ hasText: sup.name })).toContainText("3,000.00");
    await page.getByTestId("bills-table").getByRole("row").filter({ hasText: `INV-${a.tag}` }).click();
    const d = page.getByTestId("bill-detail"); await expect(d).toContainText("On hold: not payable yet"); await expect(d).toContainText("billed for more than has arrived"); await expect(d.getByTestId("bill-line-table")).toContainText("40 (−20)");
    await expect(d.getByRole("form", { name: "Record a payment" })).toHaveCount(0); await shot(page, "bill-held");
    expect((await http("POST", `/purchase-orders/${po.id}/receive`, tok, { idempotencyKey: crypto.randomUUID(), lines: [{ poLineId: line.id, qty: 20 }] })).body.billsReleased).toEqual([bill.id]);
    await page.reload(); await page.getByTestId("bills-table").getByRole("row").filter({ hasText: `INV-${a.tag}` }).click();
    await expect(d).toContainText("Open"); await expect(d.getByRole("form", { name: "Record a payment" })).toBeVisible();
    await d.getByLabel("Amount (A$)").fill("1000.00"); await d.getByRole("button", { name: /^Pay/ }).click(); await expect(d.getByTestId("bill-owed")).toHaveText("A$2,000.00"); await expect(d).toContainText("Part paid");
    await d.getByLabel("Amount (A$)").fill("2000.00"); await d.getByLabel("Reference").fill("EFT 7731"); await d.getByRole("button", { name: /^Pay/ }).click();
    await expect(d.getByTestId("bill-owed")).toHaveText("A$0.00"); await expect(d).toContainText("Paid"); await expect(d).toContainText("EFT 7731"); await shot(page, "bill-paid");
    await expect(page.getByTestId("aging-table").getByRole("row").filter({ hasText: sup.name })).toHaveCount(0);
    expect(await sql(`select status, paid_minor::int as paid from shelfline.supplier_bill where id = $1`, [bill.id])).toEqual([{ status: "paid", paid: 300000 }]);
  });
});

test.describe("transfers and stock counts", () => {
  test("send stock between stores, receive part and write off the missing unit: nothing is lost in transit and the shortage is recorded", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!, b = w.stores[1]!, v = a.variants[0]!;
    await signIn(page); await go(page, "Stock", "Transfers"); await page.getByRole("button", { name: "New transfer" }).click();
    await page.getByRole("combobox", { name: "From" }).click(); await page.getByRole("option", { name: a.name }).click();
    await page.getByRole("combobox", { name: "To" }).click(); await page.getByRole("option", { name: b.name }).click();
    await page.getByLabel("Add a product").fill(v.sku); await page.getByRole("option").first().click(); await expect(page.getByTestId("transfer-lines")).toContainText("20 on hand at the sending location");
    for (let i = 0; i < 4; i++) await page.getByTestId("transfer-lines").getByRole("button", { name: /^Increase quantity/ }).click();
    await page.getByRole("button", { name: "Save and send" }).click(); const d = page.getByTestId("transfer-detail"); await expect(d).toContainText("In transit"); await shot(page, "transfer-sent");
    const bal = async (loc: string) => Number((await sql(`select coalesce(b.on_hand, 0)::int as n from shelfline.stock_balance b where b.variant_id = $1 and b.location_id = $2`, [v.id, loc]))[0]?.n ?? 0);
    expect(await bal(a.id)).toBe(15); expect(await bal(b.id)).toBe(20);
    await d.getByRole("button", { name: "Receive", exact: true }).click(); const rc = page.getByRole("form", { name: "Receive transfer" });
    await rc.getByRole("button", { name: /^Decrease arrived/ }).click(); await rc.getByRole("radio", { name: /Lost: write off 1/ }).click(); await expect(rc).toContainText("cannot be undone"); await shot(page, "transfer-receive");
    await rc.getByRole("button", { name: "Record receipt" }).click(); await expect(d).toContainText("1 unit was written off"); await d.getByRole("button", { name: "Done" }).click();
    await expect(d).toContainText("Received"); await expect(d.getByTestId("transfer-line-table")).toContainText("Tempra Glide 3");
    expect(await bal(b.id)).toBe(24); expect(await bal(a.id)).toBe(15);
    expect(await sql(`select l.type, b.on_hand::int as n from shelfline.stock_balance b join shelfline.location l on l.id = b.location_id where b.variant_id = $1 and l.type = 'transit'`, [v.id])).toEqual([{ type: "transit", n: 0 }]);
    expect(await sql(`select qty_delta::int as q from shelfline.stock_movement where variant_id = $1 and kind = 'transfer_variance'`, [v.id])).toEqual([{ q: -1 }]);
    await expect(page.getByRole("complementary", { name: "Locations" })).not.toContainText("In transit");
  });

  test("a blind count hides the expected figures; sales during the count are kept and only the difference is adjusted", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!, v = a.variants[0]!; await openSession(a, w, 30000);
    await signIn(page); await go(page, "Stock", "Stock counts"); await page.getByRole("button", { name: "New count" }).click();
    await page.getByRole("combobox", { name: "Location" }).click(); await page.getByRole("option", { name: a.name }).click(); await page.getByRole("button", { name: "Start counting" }).click();
    const d = page.getByTestId("count-detail"); await expect(d).toContainText("Blind count: expected quantities are hidden"); await expect(d.getByRole("columnheader", { name: "Expected" })).toHaveCount(0);
    await sell(a, w, [{ v: 0, qty: 3 }], "cash");                                                                // three sales while the shelf is being counted
    await d.getByLabel(`Counted ${v.sku}`).fill("19"); await d.getByLabel(`Counted ${a.variants[1]!.sku}`).fill("20"); await d.getByLabel(`Counted ${a.variants[2]!.sku}`).fill("20"); await shot(page, "count-blind");
    await d.getByRole("button", { name: "Submit for review" }).click(); await expect(d).toContainText("In review"); await expect(d.getByRole("columnheader", { name: "Expected" })).toBeVisible();
    await expect(d).toContainText("Stock moved while you counted"); await expect(d.getByTestId("count-net")).toHaveText("-1 units"); await shot(page, "count-review");
    await d.getByRole("button", { name: "Commit adjustments" }).click(); await expect(d).toContainText("Committed: 1 item adjusted, net -1 units"); await expect(d).toContainText("Committed");
    const [b] = await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [v.id, a.id]); expect(b.n).toBe(16);   // 20 - 3 sold - 1 counted short, not "set to 19"
  });
});

test.describe("pricing", () => {
  test("make a price book for one store, price an item, see the preview win; add a promotion that stacks on it", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!, b = w.stores[1]!, v = a.variants[0]!;
    await signIn(page); await go(page, "Stock", "Pricing"); await page.getByRole("button", { name: "New price book" }).click();
    await page.getByLabel("Name").fill(`Spring ${a.tag}`); await page.getByRole("switch", { name: "Only some locations" }).click(); await page.getByRole("group", { name: "Locations" }).getByRole("button", { name: a.name }).click(); await shot(page, "pricing-new");
    await page.getByRole("button", { name: "Create price book" }).click(); const d = page.getByTestId("book-detail"); await expect(d).toContainText(`Spring ${a.tag}`); await expect(d).toContainText(a.name);
    await d.getByLabel("Add a price").fill(v.sku); await page.getByRole("option").first().click(); await d.getByLabel(`Price of ${v.sku}`).fill("179.95"); await d.getByRole("button", { name: "Save prices" }).click();
    await expect(d).toContainText("Saved. Tills pick up version 2"); await expect(d.getByLabel(`Price of ${v.sku}`)).toHaveValue("179.95"); await expect(d.getByTestId("book-entries")).toContainText("18%");     // 219.95 -> 179.95
    await d.getByRole("combobox", { name: "Preview location" }).click(); await page.getByRole("option", { name: a.name }).click(); await d.getByLabel("Preview a product").fill(v.sku); await page.getByRole("option").first().click();
    await expect(d.getByTestId("price-preview")).toContainText("A$179.95"); await expect(d.getByTestId("price-preview")).toContainText("This book sets the price.");
    await d.getByRole("combobox", { name: "Preview location" }).click(); await page.getByRole("option", { name: b.name }).click(); await expect(d.getByTestId("price-preview")).toContainText("A$219.95"); await expect(d.getByTestId("price-preview")).toContainText("No price book applies");
    await shot(page, "pricing-book");
    await page.getByRole("radio", { name: "Promotions" }).click(); await page.getByRole("button", { name: "New promotion" }).click(); await page.getByLabel("Name").fill(`Loyalty ${a.tag}`); await page.getByLabel("Percent off").fill("5");
    await page.getByRole("switch", { name: /Stackable/ }).click(); await page.getByRole("button", { name: "Create promotion" }).click();
    await expect(page.getByTestId("promos-table").getByRole("row").filter({ hasText: `Loyalty ${a.tag}` })).toContainText("5% off"); await expect(page.getByTestId("promos-table")).toContainText("Stackable"); await shot(page, "pricing-promos");
    const [pb] = await sql(`select price_minor::int as p from shelfline.price_book_entry e join shelfline.price_book b on b.id = e.price_book_id where b.name = $1`, [`Spring ${a.tag}`]); expect(pb.p).toBe(17995);
  });
});

test.describe("gift cards and store credit", () => {
  test("issue a card (the code is shown once), top it up, see its entries add up, cancel it; adjust a customer's store credit; set a store's offline gift card policy", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!;
    const cust = (await http("POST", "/customers", w.owner, { name: `Sam ${a.tag}`, email: `sam.${a.tag.toLowerCase()}@e2e.test` })).body;
    await signIn(page); await go(page, "Sell", "Gift cards"); await page.getByRole("button", { name: "Issue a card" }).click(); await page.getByLabel("Note (optional)").fill(`Birthday ${a.tag}`); await shot(page, "gift-issue");
    await page.getByRole("button", { name: "Issue card" }).click(); const code = (await page.getByTestId("new-code").locator(".mono").innerText()).trim(); expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    await page.getByRole("button", { name: "I have it" }).click(); const d = page.getByTestId("gift-detail"); await expect(d.getByTestId("gift-balance")).toHaveText("A$50.00"); await expect(d).toContainText(`…${code.slice(-4)}`);
    await d.getByLabel("Top up amount").fill("25.00"); await d.getByRole("button", { name: "Top up", exact: true }).click(); await expect(d.getByTestId("gift-balance")).toHaveText("A$75.00"); await expect(d.getByTestId("gift-entries")).toContainText("Top-up"); await shot(page, "gift-card");
    expect((await http("GET", `/gift-cards/lookup?code=${code}`, w.owner)).body).toMatchObject({ balanceMinor: 7500, status: "active" });
    expect(await sql(`select count(*)::int as n from shelfline.gift_card where code_last4 = $1 and code_hash <> $2`, [code.slice(-4), code])).toEqual([{ n: 1 }]);          // only a hash is stored, never the code
    await d.getByRole("button", { name: "Cancel this card" }).click(); await expect(d).toContainText("Cancelled"); await d.getByLabel("Top up amount").count().then((n) => expect(n).toBe(0));
    await go(page, "Sell", "Customers"); await page.getByTestId("customers-table").getByText(`Sam ${a.tag}`).click(); const cr = page.getByTestId("store-credit"); await expect(cr.getByTestId("credit-balance")).toHaveText("A$0.00");
    await cr.getByRole("button", { name: "Adjust credit" }).click(); const f = page.getByRole("form", { name: "Adjust credit" }); await f.getByLabel("Amount (A$)").fill("20.00"); await f.getByLabel("Reason").fill("Goodwill"); await f.getByRole("button", { name: "Save adjustment" }).click();
    await expect(cr.getByTestId("credit-balance")).toHaveText("A$20.00"); await expect(cr).toContainText("Goodwill"); await shot(page, "store-credit");
    await page.goto("/#/admin/locations"); await page.getByTestId("locations-table").getByText(a.name).first().click(); await page.getByRole("switch", { name: /Accept gift cards without a connection/ }).click(); await page.getByLabel(/Most one offline gift card payment/).fill("25.00"); await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved. Tills receive the new limits")).toBeVisible(); expect(await sql(`select gift_card_offline as o, gift_card_offline_cap_minor::int as c from shelfline.location where id = $1`, [a.id])).toEqual([{ o: true, c: 2500 }]);
    expect(cust.id).toBeTruthy();
  });
});

test.describe("schedule and timesheets", () => {
  const melbDay = (back: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - back * 86_400_000));
  const at = (date: string, hm: string) => { const guess = Date.parse(`${date}T${hm}:00Z`); const off = (t: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Australia/Melbourne", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t; }; return new Date(guess - off(guess - off(guess))).toISOString(); };
  const mondayOf = (d: string) => { const x = new Date(d + "T12:00:00Z"); const wd = x.getUTCDay(); x.setUTCDate(x.getUTCDate() + (wd === 0 ? -6 : 1 - wd)); return x.toISOString().slice(0, 10); };

  test("roster a person for a day from the board, see a short day, and publish the week", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const day = melbDay(-1); await http("PUT", `/locations/${a.id}/staffing`, w.owner, { [new Date(day + "T12:00:00Z").getUTCDay()]: 2 });
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "People", "Schedule"); const toNext = mondayOf(day) !== mondayOf(melbDay(0)); if (toNext) await page.getByRole("button", { name: "Next week" }).click();
    await page.getByRole("button", { name: new RegExp(`^Add shift for Priya .* on ${day}$`) }).click(); await page.getByLabel("Starts (24h)").fill("09:00"); await page.getByLabel("Ends (24h)").fill("17:00"); await page.getByRole("button", { name: "Add shift", exact: true }).click();
    const board = page.getByTestId("roster"); await expect(board.getByRole("button", { name: new RegExp(`^Shift Priya .* ${day} 09:00–17:00$`) })).toBeVisible(); await expect(page.getByTestId(`need-${day}`)).toContainText("1/2 staffed · short"); await shot(page, "roster");
    await page.getByRole("button", { name: /^Publish 1 draft$/ }).click(); await expect(page.getByText("1 shift published")).toBeVisible(); await expect(page.getByRole("button", { name: "Published" })).toBeDisabled();
    expect((await sql(`select published_at is not null as p from shelfline.shift where location_id = $1`, [a.id]))).toEqual([{ p: true }]);
  });

  test("a late arrival and a forgotten clock-out show up; a correction adds a punch (the original stays); the complete day is approved", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const day = melbDay(2); const mon = mondayOf(day);
    await http("POST", "/shifts", w.owner, { locationId: a.id, userId: w.cashier.id, date: day, start: "09:00", end: "17:00", breakMinutes: 30 }); await http("POST", "/shifts/publish", w.owner, { locationId: a.id, from: day, to: day });
    const p = (kind: string, iso: string) => ({ ...cmd(a, w, "punch.record", { punchId: crypto.randomUUID(), kind, method: "pin" }), clientTs: iso }); expect((await push(a, [p("in", at(day, "09:12"))])).status).toBe(200);
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "People", "Timesheets"); if (mon !== mondayOf(melbDay(0))) await page.getByRole("button", { name: "Previous week" }).click();
    const row = page.getByTestId("timesheet-table").getByRole("row").filter({ hasText: day }); await expect(row).toContainText("Late 12 min"); await expect(row).toContainText("No clock-out"); await expect(row.getByRole("checkbox")).toBeDisabled(); await shot(page, "timesheet-open");
    await row.getByRole("button", { name: "Correct" }).click(); const f = page.getByRole("form", { name: "Correct punch" }); await f.getByLabel(/Correct time/).fill("17:05"); await f.getByLabel("Reason").fill("Forgot to clock out, confirmed"); await f.getByRole("button", { name: "Save correction" }).click();
    await expect(row).toContainText("7h 23m"); await expect(row).not.toContainText("No clock-out"); await expect(row.getByRole("checkbox")).toBeEnabled();                    // 09:12-17:05 less a 30 minute break
    await row.getByRole("checkbox").check(); await page.getByRole("button", { name: /^Approve 1 selected$/ }).click(); await expect(page.getByText("1 approved")).toBeVisible(); await expect(row).toContainText("Approved"); await shot(page, "timesheet-approved");
    expect(await sql(`select kind, method from shelfline.punch where location_id = $1 order by client_ts`, [a.id])).toEqual([{ kind: "in", method: "pin" }, { kind: "out", method: "manual" }]);
    expect(await sql(`select status, worked_minutes::int as m from shelfline.timesheet_entry where location_id = $1`, [a.id])).toEqual([{ status: "approved", m: 443 }]);
  });
});

test.describe("attendance terminals", () => {
  test("register a terminal and pair a bridge from the back office; a record from an unknown code is held and a manager matches it to a person", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const { createHmac } = await import("node:crypto");
    await signIn(page); await go(page, "People", "Terminals"); await page.getByRole("button", { name: "Register a terminal" }).click();
    await page.getByRole("combobox", { name: "Store" }).click(); await page.getByRole("option", { name: a.name }).click(); await page.getByLabel("Serial number").fill(`CG${a.tag}0001`); await page.getByLabel("Name").fill("Staff door"); await page.getByRole("button", { name: "Register terminal" }).click();
    await expect(page.getByTestId("terminals-table")).toContainText(`CG${a.tag}0001`);
    await page.getByRole("button", { name: "Pair a bridge" }).click(); await page.getByRole("combobox", { name: "Store" }).click(); await page.getByRole("option", { name: a.name }).click(); await page.getByLabel("Name").fill("Back office PC"); await page.getByRole("button", { name: "Create pairing code" }).click();
    const code = (await page.getByTestId("pair-code").locator(".mono").first().innerText()).trim(); expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/); await shot(page, "terminals-pair"); await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("bridges-table")).toContainText("Waiting to pair");
    const p = (await http("POST", "/devices/pair", null, { pairingCode: code })).body; await page.reload(); await expect(page.getByTestId("bridges-table")).toContainText("Back office PC");
    const body = JSON.stringify({ events: [{ serial: `CG${a.tag}0001`, personCode: "4242", ts: new Date(Date.now() - 120_000).toISOString(), verify: "fingerprint" }] }); const ts = String(Math.floor(Date.now() / 1000));
    expect((await fetch(`${API}/devices/punches`, { method: "POST", headers: { "content-type": "application/json", "x-bridge-id": p.bridgeId, "x-timestamp": ts, "x-signature": createHmac("sha256", p.secret).update(`${ts}.${body}`).digest("hex") }, body })).status).toBe(200);
    await lens(page, new RegExp(a.name)).click(); const held = page.getByTestId("held-table"); await expect(held).toContainText("No one has this code"); await expect(held).toContainText("4242"); await shot(page, "terminals-held");
    await held.getByRole("combobox", { name: "Person for code 4242" }).click(); await page.getByRole("option", { name: /^Priya/ }).click(); await held.getByRole("button", { name: "Record punch" }).click(); await expect(page.getByText("Nothing held")).toBeVisible();
    expect(await sql(`select method, kind from shelfline.punch where location_id = $1`, [a.id])).toEqual([{ method: "terminal_fp", kind: "in" }]);
    await page.reload(); await expect(page.getByTestId("bridges-table")).toContainText("Online");
  });
});

test.describe("commission", () => {
  test("write a rule, try a sale against it, open a period, see the cashier's statement line by line, add an adjustment; a period that has not ended cannot be closed", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w); expect(["accepted", "accepted_flagged"]).toContain((await sell(a, w, [{ v: 0, qty: 1 }], "card")).body.results[0].status);   // A$219.95 at Fitzroy
    await signIn(page); await go(page, "Money", "Commission rules"); await expect(page.getByText("No rules yet")).toBeVisible();
    await page.getByRole("button", { name: "New rule" }).click(); await page.getByLabel("Rate (%)").fill("4"); await page.getByRole("button", { name: "Save version" }).click();
    const table = page.getByTestId("rules-table"); await expect(table).toContainText("Everything else"); await expect(table).toContainText("4%"); await shot(page, "commission-rules");
    // try it: the golden sale is A$8.00
    await page.getByLabel("Product").fill(a.variants[0]!.sku); await page.getByRole("option").first().click();
    await expect(page.getByTestId("preview-result")).toContainText("$8.00"); await expect(page.getByTestId("preview-result")).toContainText("GST A$20.00"); await shot(page, "commission-preview");
    // a version starting the same day as an existing one is refused: history is never overwritten
    await table.getByRole("button", { name: "New version" }).click(); await page.getByLabel("Rate (%)").fill("6"); await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByRole("alert")).toContainText("already has a version starting that day"); await page.getByRole("button", { name: "Cancel" }).click();
    await table.getByRole("button", { name: /History/ }).click(); await expect(table).toContainText("Version 1"); await expect(table).toContainText("4%");
    await go(page, "Money", "Commission"); await expect(page.getByText("No periods yet")).toBeVisible();
    const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await page.getByRole("button", { name: "Add period" }).first().click(); await page.getByLabel("First day").fill(d(-3)); await page.getByLabel("Last day").fill(d(3)); await page.getByRole("form", { name: "New period" }).getByRole("button", { name: "Add period" }).click();
    const st = page.getByTestId("statements-table"); const row = st.getByRole("row", { name: new RegExp(`Priya ${a.tag}`) }); await expect(row).toContainText("8.00");   // the rule was 4% when version 1 started, and 6% only from the date chosen for version 2
    await shot(page, "commission-statement");
    await row.getByRole("button", { name: /1 line/ }).click(); const det = page.getByTestId("detail-table"); await expect(det).toContainText("Earned"); await expect(det).toContainText("Tempra Glide 3"); await expect(det).toContainText("4% v1"); await shot(page, "commission-detail");
    await page.getByRole("button", { name: "All people" }).click();
    await page.getByRole("button", { name: "Add adjustment" }).click(); await page.getByRole("button", { name: `Priya ${a.tag}` }).click(); await page.getByLabel(/Amount/).fill("-3.00"); await page.getByLabel("Reason").fill("Counted wrong"); await page.getByRole("button", { name: /^Add adjustment$/ }).last().click();
    await expect(row).toContainText("5.00");
    await page.getByRole("button", { name: /Close period/ }).click(); await expect(page.getByText("has not ended yet")).toBeVisible();
    expect(await sql(`select kind, amount_minor::int as a from shelfline.commission_entry where user_id = $1 order by kind`, [w.cashier.id])).toEqual([{ kind: "adjust", a: -300 }, { kind: "earn", a: 800 }]);
  });
});

test.describe("report access", () => {
  test("give an accountant a limited view, preview exactly what they would see, then withdraw it", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w); expect(["accepted", "accepted_flagged"]).toContain((await sell(a, w, [{ v: 0, qty: 1 }], "card")).body.results[0].status);
    const email = `ines.${a.tag.toLowerCase()}@accounts.test`;
    await signIn(page); await go(page, "Money", "Report access"); await expect(page.getByRole("button", { name: "Give access" })).toBeEnabled();
    await page.getByRole("button", { name: "Give access" }).click(); const form = page.getByRole("form", { name: "Report access" });
    await form.getByLabel("Email").fill(email); await form.getByLabel("Name").fill("Ines Walker"); await form.getByRole("checkbox", { name: new RegExp(a.name) }).check();
    await expect(form.getByRole("checkbox", { name: /Cost of goods/ })).toBeChecked(); await expect(form.getByRole("checkbox", { name: /Margin/ })).toBeChecked(); await shot(page, "report-access-form");
    await form.getByRole("button", { name: "Give access and send invite" }).click();
    const row = page.getByTestId("grants-table").getByRole("row", { name: new RegExp("Ines Walker") }); await expect(row).toContainText(a.name); await expect(row).toContainText("Cost of goods, Margin"); await expect(row).toContainText("Active");
    expect((await http<any[]>("GET", `/dev/mailbox?to=${encodeURIComponent(email)}`, null)).body[0].kind).toBe("portal_invite");
    await row.getByRole("button", { name: "Preview" }).click(); const banner = page.getByTestId("preview-banner"); await expect(banner).toContainText(a.name); await expect(banner).toContainText("hidden: cost of goods, margin");
    const t = page.getByTestId("preview-table"); await expect(t).toContainText("Net"); await expect(t).not.toContainText("Cost of goods"); await expect(t).toContainText("219.95"); await shot(page, "report-access-preview");
    await page.getByRole("button", { name: "Close preview" }).click(); await row.getByRole("button", { name: "Views" }).click(); await expect(page.getByText("Not opened yet")).toBeVisible(); await page.getByRole("button", { name: "Close views" }).click();
    await row.getByRole("button", { name: "Revoke" }).click(); await expect(row).toContainText("Revoked"); await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    expect(await sql(`select action from shelfline.audit_log where action like 'report_grant.%' order by id`)).toEqual([{ action: "report_grant.create" }, { action: "report_grant.revoke" }]);
  });
});

test.describe("notifications", () => {
  test("a rule is written in the back office; a no-sale on the till reaches the inbox and the bell within seconds; it can be read, and the log shows it", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w);
    await signIn(page); await go(page, "Today", "Inbox"); await expect(page.getByText("Nothing yet")).toBeVisible();
    await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "Notifications", exact: true }).click(); await expect(page.getByText("No rules yet")).toBeVisible();
    await page.getByRole("button", { name: "New rule" }).click(); const form = page.getByRole("form", { name: "Notification rule" });
    await form.getByLabel("Name").fill("No-sales to owners"); await form.getByRole("checkbox", { name: "Store managers there" }).uncheck(); await form.getByRole("checkbox", { name: "Owners" }).check(); await shot(page, "notification-rule");
    await form.getByRole("button", { name: "Add rule" }).click(); const t = page.getByTestId("rules-table"); await expect(t).toContainText("No-sales to owners"); await expect(t).toContainText("Every location"); await expect(t).toContainText("Owners");
    // the till opens the drawer with no sale
    const r = await cashMove(a, w, "no_sale", 0, "change for a customer"); expect(["accepted", "accepted_flagged"]).toContain(r.body.results[0].status);
    await expect(page.getByTestId("inbox-link")).toHaveAttribute("aria-label", "Inbox: 1 unread", { timeout: 25_000 });
    await page.getByTestId("inbox-link").click(); const item = page.getByTestId("inbox-item").first(); await expect(item).toContainText(`No-sale at ${a.name}`); await expect(item).toContainText("change for a customer"); await shot(page, "inbox");
    await item.getByRole("button", { name: "Mark read" }).click(); await expect(page.getByTestId("inbox-link")).toHaveAttribute("aria-label", "Inbox: 0 unread");
    await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "Notifications", exact: true }).click(); await expect(page.getByTestId("log-table")).toContainText(`No-sale at ${a.name}`); await expect(page.getByTestId("rules-table")).toContainText("1");
    await page.getByTestId("rules-table").getByRole("button", { name: "Pause" }).click(); await expect(page.getByTestId("rules-table")).toContainText("Paused");
  });
});

test.describe("end-of-day reports", () => {
  test("set up a schedule, send a test, read the report and find the PDF in the outbox", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await openSession(a, w); expect(["accepted", "accepted_flagged"]).toContain((await sell(a, w, [{ v: 0, qty: 1 }], "card")).body.results[0].status);
    await signIn(page); await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "End of day", exact: true }).click(); await expect(page.getByText("No schedules yet")).toBeVisible();
    await page.getByRole("button", { name: "New schedule" }).click(); const form = page.getByRole("form", { name: "End-of-day schedule" });
    await form.getByLabel("Name").fill(`Close ${a.tag}`); await form.getByRole("switch", { name: "Every store" }).click(); await form.getByRole("checkbox", { name: new RegExp(a.name) }).check(); await form.getByLabel("Recipients").fill("owner@e2e.test, accounts@e2e.test"); await shot(page, "eod-form");
    await form.getByRole("button", { name: "Add schedule" }).click(); const t = page.getByTestId("schedules-table"); await expect(t).toContainText(`Close ${a.tag}`); await expect(t).toContainText("21:30"); await expect(t).toContainText("Email + PDF"); await expect(t).toContainText("every day");
    await t.getByRole("button", { name: "Send a test now" }).click(); await expect(page.getByText(/Sent a provisional test/)).toBeVisible();          // the register is still open, so it says so
    const runs = page.getByTestId("runs-table"); await expect(runs).toContainText("Provisional"); await expect(runs).toContainText("owner@e2e.test, accounts@e2e.test"); await runs.getByRole("button", { name: "View" }).click();
    const text = page.getByTestId("run-text"); await expect(text).toContainText("PROVISIONAL"); await expect(text).toContainText("Still open"); await expect(text).toContainText("219.95"); await shot(page, "eod-report");
    const mail = (await http<any[]>("GET", "/dev/mailbox?to=owner@e2e.test", null)).body.find((m) => m.kind === "eod_report"); expect(mail.subject).toMatch(/^\[Provisional\] End of day: Close /); expect(mail.attachment).toMatchObject({ type: "application/pdf" }); expect(mail.attachment.bytes).toBeGreaterThan(500);
    await t.getByRole("button", { name: "Pause" }).click(); await expect(t).toContainText("Paused");
  });
});

test.describe("printers and card terminals", () => {
  test("add a receipt printer and a card terminal, queue a test page, see it waiting; a web address is refused for a printer", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; await signIn(page); await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "Printers & cards", exact: true }).click();
    await expect(page.getByText("No printers yet")).toBeVisible(); await page.getByRole("button", { name: "Add printer" }).first().click(); let form = page.getByRole("form", { name: "Add printer" });
    await form.getByRole("combobox", { name: "Store" }).click(); await page.getByRole("option", { name: a.name }).click(); await form.getByLabel("Printer address").fill("http://192.168.1.50/print"); await form.getByRole("button", { name: "Add printer" }).click(); await expect(form.getByRole("alert")).toContainText("Not a web address");
    await form.getByLabel("Printer address").fill("192.168.1.50"); await form.getByRole("button", { name: "Add printer" }).click(); const t = page.getByTestId("printers-table"); await expect(t).toContainText("192.168.1.50:9100"); await expect(t).toContainText("Nothing printed yet");
    await t.getByRole("button", { name: "Test print" }).click(); await expect(page.getByText(/test page is queued for Front desk/)).toBeVisible(); await expect(t).toContainText("1 waiting"); await shot(page, "devices-printers");
    await page.getByRole("button", { name: "Add card terminal" }).first().click(); form = page.getByRole("form", { name: "Add card terminal" }); await form.getByRole("combobox", { name: "Store" }).click(); await page.getByRole("option", { name: a.name }).click(); await form.getByLabel("Reader id").fill("tmr_SIM1"); await form.getByRole("button", { name: "Add terminal" }).click();
    await expect(page.getByTestId("readers-table")).toContainText("tmr_SIM1"); await expect(page.getByText("Simulated terminal")).toBeVisible(); await shot(page, "devices-cards");
    await t.getByRole("button", { name: "Turn off" }).click(); await expect(t).toContainText("Off");
  });
});

test.describe("online orders", () => {
  test("turn on pickups for a store, see what customers reserved, mark one ready and cancel another with a reason (the stock comes back)", async ({ page }) => {
    w = await provisionWorld({ stock: 3 }); const a = w.stores[0]!; await signIn(page); await page.goto("/#/admin/locations"); await page.getByTestId("locations-table").getByText(a.name).first().click();
    await page.getByRole("switch", { name: /Customers can reserve online and collect here/ }).click(); await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await sql(`select pickup_enabled from shelfline.location where id = $1`, [a.id]))[0]!.pickup_enabled).toBe(true);
    const org = (await (await fetch(`${API}/shop-default`)).json()) as { orgId: string }; const place = async (email: string, qty: number) => { const r = await fetch(`${API}/shop/${org.orgId}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: `Cust ${email.split("@")[0]}`, locationId: a.id, lines: [{ variantId: a.variants[2]!.id, qty }] }) }); expect(r.status).toBe(201); return (await r.json()) as { id: string; number: string }; };
    const one = await place(`one.${a.tag}@example.com`, 1); const two = await place(`two.${a.tag}@example.com`, 2); expect(Number((await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [a.variants[2]!.id, a.id]))[0]!.n)).toBe(0);
    await go(page, "Sell", "Online orders"); const t = page.getByTestId("online-orders-table"); await expect(t).toContainText(one.number); await expect(t).toContainText(two.number); await shot(page, "online-orders");
    const r1 = t.getByRole("row", { name: new RegExp(one.number) }); await r1.getByRole("button", { name: "Mark ready" }).click(); await expect(r1).toContainText("Ready to collect"); expect((await http<any[]>("GET", `/dev/mailbox?to=one.${a.tag}@example.com`, null)).body.map((m) => m.kind)).toContain("online_order_ready");
    const r2 = t.getByRole("row", { name: new RegExp(two.number) }); await r2.getByRole("button", { name: "Cancel" }).click(); await page.getByRole("form", { name: `Cancel ${two.number}` }).getByLabel("Why is it being cancelled?").fill("Customer rang to cancel"); await page.getByRole("button", { name: "Cancel the order" }).click();
    await expect(page.getByText(/Cancelled. The stock is back/)).toBeVisible(); expect(Number((await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [a.variants[2]!.id, a.id]))[0]!.n)).toBe(2);
    await page.getByRole("radio", { name: "Cancelled or expired" }).click(); await expect(t).toContainText("Customer rang to cancel");
  });
});

test.describe("sales channels", () => {
  test("connect a Shopify shop, match products by SKU, send stock, take a signed order and see it, then check against Shopify", async ({ page }) => {
    const { createServer } = await import("node:http"); const { createHmac } = await import("node:crypto"); const levels = new Map<string, number>(); let w2: World | undefined;
    const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const url = new URL(req.url!, "http://x"); const j = (o: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.headers["x-shopify-access-token"] !== "shpat_e2e_token") return j({}, 401); if (url.pathname.endsWith("/shop.json")) return j({ shop: { name: "E2E shop" } });
      if (url.pathname.endsWith("/products.json")) return j({ products: [{ id: 1, title: "Tempra Glide 3", variants: [{ id: 501, sku: w2!.stores[0]!.variants[0]!.sku, inventory_item_id: 7001, title: "10.5" }, { id: 502, sku: "NO-MATCH", inventory_item_id: 7002, title: "x" }] }] });
      if (url.pathname.endsWith("/inventory_levels/set.json")) { const o = JSON.parse(b); levels.set(String(o.inventory_item_id), o.available); return j({}); } if (url.pathname.endsWith("/inventory_levels.json")) return j({ inventory_levels: [...levels].map(([k, v]) => ({ inventory_item_id: Number(k), available: v })) }); j({}, 404); }); });
    await new Promise<void>((ok) => fake.listen(19481, "127.0.0.1", ok));
    try {
      w2 = await provisionWorld({ stock: 6 }); const a = w2.stores[0]!; await signIn(page); await go(page, "Sell", "Channels"); await expect(page.getByText("No channels yet")).toBeVisible();
      await page.getByRole("button", { name: "Connect Shopify" }).first().click(); const form = page.getByRole("form", { name: "Connect Shopify" }); await form.getByLabel("Name").fill("E2E online"); await form.getByLabel("Shop address").fill(`e2e${a.tag.toLowerCase()}.myshopify.com`); await form.getByLabel("Admin API access token").fill("shpat_wrong_one");
      await form.getByLabel("Webhook signing secret").fill("whsec_e2e_secret"); await form.getByRole("combobox").click(); await page.getByRole("option", { name: new RegExp(a.name) }).click(); await form.getByLabel("Shopify location id").fill("55001");
      await form.getByRole("button", { name: "Connect shop" }).click(); await expect(form.getByRole("alert")).toContainText("Shopify refused that access token"); await form.getByLabel("Admin API access token").fill("shpat_e2e_token"); await form.getByRole("button", { name: "Connect shop" }).click();
      const ch = page.getByTestId("channel"); await expect(ch).toContainText("E2E online"); await expect(ch).toContainText("Connected"); await expect(page.getByTestId("webhook-url")).toContainText("/channels/shopify/webhooks/"); await shot(page, "channels");
      await ch.getByRole("button", { name: "Match products by SKU" }).click(); await expect(ch.getByText(/Matched 1 new product option/)).toBeVisible(); await expect(page.getByTestId("unmatched")).toContainText("NO-MATCH"); await expect(page.getByTestId("listings-table")).toContainText(a.variants[0]!.sku);
      await ch.getByRole("button", { name: "Send stock now" }).click(); await expect(ch.getByText(/Sent 1 quantity/)).toBeVisible(); expect(levels.get("7001")).toBe(6);
      const [conn] = await sql(`select id from shelfline.channel_connection order by created_at desc limit 1`); const body = JSON.stringify({ id: 9001, name: "#9001", currency: "AUD", total_price: "439.90", email: "shopper@example.com", line_items: [{ variant_id: 501, sku: a.variants[0]!.sku, quantity: 2, title: "Tempra Glide 3" }] });
      const hook = await fetch(`${API}/channels/shopify/webhooks/${conn.id}`, { method: "POST", headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "wh-1", "x-shopify-hmac-sha256": createHmac("sha256", "whsec_e2e_secret").update(body).digest("base64") }, body }); expect((await hook.json()).status).toBe("imported");
      expect((await sql(`select on_hand::int as n from shelfline.stock_balance where variant_id = $1 and location_id = $2`, [a.variants[0]!.id, a.id]))[0]!.n).toBe(4); await expect.poll(() => levels.get("7001")).toBe(4);
      await page.reload(); await expect(page.getByTestId("channel-orders-table")).toContainText("#9001"); await expect(page.getByTestId("channel-orders-table")).toContainText("Taken off stock");
      levels.set("7001", 99); await ch.getByRole("button", { name: "Check Shopify against Shelfline" }).click(); await expect(ch.getByText(/1 had drifted in Shopify and were corrected/)).toBeVisible(); expect(levels.get("7001")).toBe(4);
    } finally { fake.close(); }
  });
});

test.describe("marketing and loyalty", () => {
  test("write a campaign, see exactly who it would reach, send it only to those who agreed; switch on an automatic email; run a loyalty program and spend points", async ({ page }) => {
    w = await provisionWorld(); const owner = await ownerToken(); const tag = w.stores[0]!.tag.toLowerCase();
    const mk = async (name: string, email: string | null, consent: boolean | null) => (await http<{ id: string }>("POST", "/customers", owner, { name, ...(email ? { email } : {}), ...(consent === null ? {} : { marketingConsent: { email: consent } }) })).body.id;
    const yes = await mk(`Ana ${tag}`, `ana.${tag}@example.com`, true); await mk(`Ben ${tag}`, `ben.${tag}@example.com`, false); await mk(`Cam ${tag}`, null, true);
    await signIn(page); await go(page, "Grow", "Groups"); await expect(page.getByTestId("preview")).toContainText("will get it"); await page.getByLabel("Name").fill("Everyone for now"); await page.getByRole("button", { name: "Save group" }).click(); await expect(page.getByTestId("segments-table")).toContainText("Everyone for now"); await shot(page, "grow-groups");
    await go(page, "Grow", "Campaigns"); await page.getByRole("button", { name: "New campaign" }).click(); const form = page.getByRole("form", { name: "New campaign" }); await form.getByLabel("Name").fill(`Spring ${tag}`); await form.getByLabel("Subject").fill("Hello {{first_name}}"); await form.getByRole("button", { name: "Save draft" }).click();
    const review = page.getByRole("heading", { name: /Ready to send: Spring/ }); await expect(review).toBeVisible(); const aud = page.getByTestId("audience"); await expect(aud).toContainText("have not agreed to email"); await expect(aud).toContainText("have no email address"); await shot(page, "grow-campaign");
    await page.getByRole("button", { name: /^Send to \d+ people/ }).click(); await expect(page.getByText(/Sent to \d+ (person|people)\./)).toBeVisible(); await expect(page.getByTestId("campaigns-table")).toContainText("Sent");
    const got = (await http<any[]>("GET", `/dev/mailbox?to=ana.${tag}@example.com`, null)).body.filter((m) => m.kind === "marketing"); expect(got).toHaveLength(1); expect(got[0].subject).toBe("Hello Ana"); expect(got[0].body).toContain("/marketing/unsubscribe?c=");
    expect((await http<any[]>("GET", `/dev/mailbox?to=ben.${tag}@example.com`, null)).body.filter((m) => m.kind === "marketing")).toHaveLength(0);
    await go(page, "Grow", "Automatic emails"); const flows = page.getByTestId("flows"); await expect(flows).toContainText("Win back lapsed customers"); await flows.getByRole("switch").first().click(); await expect(flows.getByRole("switch").first()).toHaveAttribute("aria-checked", "true");
    await go(page, "Grow", "Loyalty"); await page.getByRole("switch", { name: "Off" }).click(); await expect(page.getByRole("switch", { name: "On" })).toBeVisible();
    expect((await http("POST", `/loyalty/customers/${yes}/adjust`, owner, { points: 250, reason: "Welcome gift", idempotencyKey: crypto.randomUUID() })).status).toBe(200); await page.reload(); const members = page.getByTestId("members-table"); await expect(members).toContainText(`Ana ${tag}`); await expect(members).toContainText("250");
    await members.getByRole("button", { name: "Redeem 100" }).click(); await expect(page.getByText(/Turned into .*5\.00 of store credit/)).toBeVisible(); await expect(members).toContainText("150"); await shot(page, "grow-loyalty");
    await page.goto("/#/sell/customers/" + yes); await expect(page.getByTestId("loyalty")).toContainText("150 points"); await expect(page.getByTestId("credit-balance")).toContainText("5.00");
  });
});

test.describe("accounting and reordering", () => {
  test("see a closed day as a balanced journal, fill in account codes, download it as CSV, and see it in the history; an open register blocks the export", async ({ page }) => {
    w = await provisionWorld(); const a = w.stores[0]!; const owner = await ownerToken(); await openSession(a, w); await sell(a, w, [{ v: 0, qty: 1 }], "cash"); await sell(a, w, [{ v: 1, qty: 2 }], "card");
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Money", "Accounting");
    const picker = page.getByRole("combobox", { name: "Store" });
    await expect(page.getByText("Register open").first()).toBeVisible(); await expect(page.getByRole("button", { name: "Download CSV" })).toBeDisabled(); await expect(page.getByRole("button", { name: "Export to Xero" })).toBeDisabled();
    await expect(page.getByTestId("journal-table")).toContainText("Journal preview"); await expect(page.getByTestId("journal-table")).toContainText("Balanced");
    await closeSession(a, w, 51995); await go(page, "Money", "Reports"); await go(page, "Money", "Accounting");
    await expect(page.getByText("Ready to export").first()).toBeVisible(); await expect(page.getByText(/No account code for/)).toBeVisible();
    const codes: Record<string, string> = { cash: "1000", card_clearing: "1010", gift_card_liability: "2100", store_credit_liability: "2110", other_clearing: "1020", sales_revenue: "4000", gst_collected: "2200", rounding: "4900", cash_over_short: "4910", cogs: "5000", inventory: "1200", suspense: "9999" };
    for (const [k, v] of Object.entries(codes)) await page.locator(`#acct-${k}`).fill(v); await page.getByRole("button", { name: "Save codes" }).click(); await expect(page.getByText(/No account code for/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export to Xero" })).toBeDisabled(); await expect(page.getByText("Not connected").first()).toBeVisible();
    const dl = page.waitForEvent("download"); await page.getByRole("button", { name: "Download CSV" }).click(); const file = await dl; expect(file.suggestedFilename()).toMatch(/^SHELFLINE-.*\.csv$/);
    await expect(page.getByText(/Exported as SHELFLINE-/)).toBeVisible(); await expect(page.getByTestId("export-history")).toContainText("CSV"); await expect(page.getByText("Exported").first()).toBeVisible(); await expect(page.getByRole("button", { name: "Download CSV" })).toBeDisabled(); await shot(page, "accounting");
    expect((await http("GET", "/accounting/exports", owner)).body.length).toBeGreaterThanOrEqual(1);
  });

  test("a supplier's lead time drives the reorder list; tick what to buy, change a quantity, create one draft order per supplier, and nothing is sent", async ({ page }) => {
    w = await provisionWorld({ stock: 12 }); const a = w.stores[0]!; const tok = await ownerToken(); await openSession(a, w); await sell(a, w, [{ v: 0, qty: 10 }], "card");
    const sup = (await http("POST", "/suppliers", tok, { name: `Tempra ${a.tag}`, leadTimeDays: 21, termsDays: 30 })).body; await http("POST", "/purchase-orders", tok, { supplierId: sup.id, locationId: a.id, lines: [{ variantId: a.variants[0]!.id, qty: 5, unitCostMinor: 9000 }] });
    const before = Number((await sql("select count(*)::int as n from shelfline.purchase_order where location_id = $1", [a.id]))[0].n);
    await signIn(page); await lens(page, new RegExp(a.name)).click(); await go(page, "Stock", "Reorder"); const t = page.getByTestId("reorder-table");
    await expect(t).toContainText(a.variants[0]!.sku); await expect(t).toContainText(`Tempra ${a.tag}`); await expect(t).toContainText("21 day lead time"); await shot(page, "reorder");
    await page.getByRole("button", { name: "Increase quantity of " + a.variants[0]!.sku }).click();
    await page.getByRole("button", { name: /^Create draft orders/ }).click(); await expect(page.getByText(/1 draft order created/)).toBeVisible();
    const after = await sql("select status from shelfline.purchase_order where location_id = $1 order by created_at desc", [a.id]); expect(after).toHaveLength(before + 1); expect(after[0].status).toBe("draft");
    await go(page, "Stock", "Reorder"); await page.getByRole("checkbox", { name: new RegExp(`Order ${a.variants[0]!.sku}`) }).click(); await expect(page.getByRole("button", { name: /^Create draft orders/ })).toBeDisabled();
    await go(page, "Money", "Suppliers"); await expect(page.getByTestId("suppliers-table")).toContainText("21 days");
  });
});

test.describe("single sign-on", () => {
  test("an owner connects an identity provider, a person signs in through it (and back out), and someone without an account here is turned away politely", async ({ page }) => {
    const idp = new FakeIdp(19501); await idp.start();
    try {
      w = await provisionWorld(); await signIn(page); await page.getByRole("link", { name: "Admin settings" }).click(); await page.getByRole("navigation", { name: "Admin pages" }).getByRole("link", { name: "Single sign-on" }).click();
      await expect(page.getByTestId("redirect-uri")).toContainText("/auth/sso/callback");
      await page.getByLabel("Provider address (issuer)").fill("http://example.com"); await page.getByLabel("Client id").fill(idp.clientId); await page.getByLabel("Client secret").fill(idp.clientSecret); await page.getByRole("button", { name: "Save" }).click(); await expect(page.getByRole("alert")).toContainText("must start with https");
      await page.getByLabel("Provider address (issuer)").fill(idp.issuer); await page.getByRole("button", { name: "Save" }).click(); await expect(page.getByText("Saved.")).toBeVisible(); await expect(page.getByText("On", { exact: true })).toBeVisible(); await shot(page, "sso");
      await page.getByRole("button", { name: "Account menu" }).click(); await page.getByRole("menuitem", { name: "Sign out" }).click();
      await page.getByRole("button", { name: "Use single sign-on" }).click(); await page.getByLabel("Organisation").fill("no-such-org"); await page.getByRole("button", { name: "Continue to your provider" }).click(); await expect(page.getByRole("alert")).toContainText("does not use single sign-on");
      idp.loginAs = w.manager.email; await page.getByLabel("Organisation").fill("kestrel-run-co"); await page.getByRole("button", { name: "Continue to your provider" }).click();
      await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible({ timeout: 15_000 }); await page.getByRole("button", { name: "Account menu" }).click(); await expect(page.getByRole("menu")).toContainText(w.manager.email); await page.getByRole("menuitem", { name: "Sign out" }).click();
      idp.loginAs = "nobody@e2e.test"; await page.getByRole("button", { name: "Use single sign-on" }).click(); await page.getByLabel("Organisation").fill("kestrel-run-co"); await page.getByRole("button", { name: "Continue to your provider" }).click();
      await expect(page.getByRole("alert")).toContainText("no active account"); await page.getByRole("link", { name: "Back to sign in" }).click(); await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await page.getByLabel("Email").fill(OWNER.email); await page.getByLabel("Password").fill(OWNER.password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();      // the password still works
    } finally { idp.stop(); }
  });
});
