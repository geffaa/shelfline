import { expect, test, type Page } from "@playwright/test";
import { addByBarcode, ownerPatchLocation, pairAndOpen, provisionShop, queued, sql, typeDigits, type Shop } from "./fixtures";

const nav = (page: Page, name: string) => page.getByRole("link", { name }).click();
const waitDrained = async (page: Page) => expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
const shot = (page: Page, name: string) => page.screenshot({ path: `../../.impeccable/review/pos-${name}.png` });
async function sellCash(page: Page, codes: string[], exactLabel = "Exact") {
  for (const c of codes) await addByBarcode(page, c);
  await page.getByRole("button", { name: /^Pay A\$/ }).click(); await page.getByRole("button", { name: exactLabel }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: "New sale" }).click();
}
async function sellCard(page: Page, codes: string[]) {
  for (const c of codes) await addByBarcode(page, c);
  await page.getByRole("button", { name: /^Pay A\$/ }).click(); await page.getByRole("radio", { name: "Card", exact: true }).click(); await page.getByRole("button", { name: /^Add card A\$/ }).click(); await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: "New sale" }).click();
}
const rows = (q: string, shop: Shop) => sql(q, [`S${shop.tag}`]);
const approveWith = async (page: Page, who: { code: string; pin: string }, label = "Approve") => { await page.getByLabel("Manager employee code").fill(who.code); await typeDigits(page, who.pin); await page.getByRole("button", { name: label, exact: true }).click(); };

test.describe("cash drawer", () => {
  test("pay in, pay out, safe drop and no-sale are written down with a reason and reach the server unflagged", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop); await nav(page, "Cash");
    const entry = async (kind: string, digits: string, reason: string) => {
      await page.getByRole("button", { name: kind, exact: true }).click();
      if (digits) await typeDigits(page, digits);
      await page.getByRole("combobox", { name: "Reason" }).click(); await page.getByRole("option", { name: reason }).click();
      await page.getByRole("button", { name: new RegExp(`^Record ${kind.toLowerCase()}`) }).click();
    };
    await entry("Pay in", "5000", "Change top-up"); await entry("Pay out", "3200", "Courier"); await entry("Safe drop", "50000", "Safe drop"); await entry("No sale", "", "Change for customer");
    await expect(page.getByTestId("cash-list")).toContainText("Pay out · Courier"); await expect(page.getByTestId("cash-list")).toContainText("32.00");
    await shot(page, "cash");
    await expect.poll(async () => (await rows(`select count(*)::int as n from shelfline.cash_movement m join shelfline.location l on l.id = m.location_id where l.code = $1`, shop))[0]!.n, { timeout: 30_000 }).toBe(4);
    expect((await rows(`select kind, amount_minor, reason, flags from shelfline.cash_movement m join shelfline.location l on l.id = m.location_id where l.code = $1 order by at`, shop))).toEqual([
      { kind: "pay_in", amount_minor: 5000, reason: "Change top-up", flags: [] }, { kind: "pay_out", amount_minor: 3200, reason: "Courier", flags: [] }, { kind: "drop", amount_minor: 50000, reason: "Safe drop", flags: [] }, { kind: "no_sale", amount_minor: 0, reason: "Change for customer", flags: [] }]);
  });
  test("a reason is required: the confirm button stays off until one is chosen", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop); await nav(page, "Cash");
    await page.getByRole("button", { name: "Pay out", exact: true }).click(); await typeDigits(page, "500");
    await expect(page.getByRole("button", { name: /^Record pay out/ })).toBeDisabled();
    await page.getByRole("combobox", { name: "Reason" }).click(); await page.getByRole("option", { name: "Supplies" }).click();
    await expect(page.getByRole("button", { name: /^Record pay out/ })).toBeEnabled();
  });
});

test.describe("refunds", () => {
  test("partial refund of a card sale: over the cashier's limit a manager approves; the goods go back on the shelf; the server records the approver", async ({ page }) => {
    const shop = await provisionShop(); await ownerPatchLocation(shop, { cashierRefundLimitMinor: 5000 });
    await pairAndOpen(page, shop); await sellCard(page, [shop.variants[0]!.barcode, shop.variants[0]!.barcode]);
    await nav(page, "Orders"); await page.getByTestId("order-row").first().click();
    await page.getByRole("button", { name: /increase .* refund quantity/i }).click();
    await page.getByRole("combobox", { name: "Refund reason" }).click(); await page.getByRole("option", { name: "Wrong size" }).click();
    await expect(page.getByTestId("refund-plan-total")).toHaveText("A$219.95");
    await page.getByRole("button", { name: "Ask a manager" }).click(); await approveWith(page, shop.manager);
    await expect(page.getByText(`Approved by ${shop.manager.name}`)).toBeVisible();
    await shot(page, "refund");
    await page.getByRole("button", { name: "Refund A$219.95" }).click();
    await expect(page.getByTestId("refund-total")).toHaveText("A$219.95"); await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("order-row").first()).toContainText("Part refunded");
    await expect.poll(async () => (await rows(`select count(*)::int as n from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.code = $1`, shop))[0]!.n, { timeout: 30_000 }).toBe(1);
    const [r] = await rows(`select r.total_minor, r.tender, r.approved_by, r.flags from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.code = $1`, shop);
    expect(r).toMatchObject({ total_minor: 21995, tender: "card", flags: [] }); expect(r.approved_by).not.toBeNull();
    const [st] = await sql(`select b.on_hand, sl.refunded_qty from shelfline.stock_balance b join shelfline.variant v on v.id = b.variant_id join shelfline.sale_line sl on sl.variant_id = v.id where v.sku = $1`, [shop.variants[0]!.sku]);
    expect(st).toEqual({ on_hand: 9, refunded_qty: 1 });                                                            // 10 - 2 sold + 1 back
    // the second pair cannot be refunded twice: the screen only offers what is left
    await page.getByTestId("order-row").first().click(); await expect(page.getByText("1 already refunded.")).toBeVisible();
  });

  test("offline: sell cash and refund it, all while disconnected; on reconnect the server has both and the cash is back where it started", async ({ page, context }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop); await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true); await expect(page.getByTestId("sync-pill")).toContainText("Offline");
    await sellCash(page, [shop.variants[1]!.barcode]);
    await nav(page, "Orders"); await page.getByTestId("order-row").first().click();
    await page.getByRole("button", { name: /increase .* refund quantity/i }).click(); await page.getByRole("combobox", { name: "Refund reason" }).click(); await page.getByRole("option", { name: "Faulty" }).click();
    await page.getByRole("radio", { name: "Cash" }).click();
    await page.getByRole("button", { name: "Refund A$89.00" }).click(); await expect(page.getByTestId("refund-total")).toHaveText("A$89.00"); await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("sync-pill")).toHaveText(/Offline · \d+ saved/);                                       // at least the sale and the refund are waiting
    await context.setOffline(false);
    await expect.poll(async () => (await rows(`select count(*)::int as n from shelfline.refund r join shelfline.location l on l.id = r.location_id where l.code = $1`, shop))[0]!.n, { timeout: 30_000 }).toBe(1);
    await waitDrained(page);
    const [b] = await sql(`select b.on_hand from shelfline.stock_balance b join shelfline.variant v on v.id = b.variant_id where v.sku = $1`, [shop.variants[1]!.sku]); expect(b.on_hand).toBe(10);
    const [z] = await sql(`select s.id from shelfline.register_session s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]);
    const res = await fetch(`http://localhost:8201/sessions/${z.id}`, { headers: { authorization: `Bearer ${shop.ownerToken}` } }); const zr = await res.json();
    expect(zr.z).toMatchObject({ expectedMinor: 15000, grossSalesMinor: 8900, refundsMinor: 8900, netSalesMinor: 0 });   // float 150.00 + 89.00 sold - 89.00 refunded
  });
});

test.describe("closing the register", () => {
  async function count(page: Page, name: string, times: number) { for (let i = 0; i < times; i++) await page.getByRole("button", { name: new RegExp(`increase ${name} count`, "i") }).click(); }
  async function toClose(page: Page) { await nav(page, "Shift"); await page.getByRole("button", { name: /Close register/ }).click(); }

  test("blind count, then the difference; the server's final figure equals the till's provisional one; a new cashier must open a new register", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await sellCash(page, shop.variants.map((v) => v.barcode));                                                       // 219.95 + 89.00 + 34.00 = 342.95
    await nav(page, "Cash"); await page.getByRole("button", { name: "Pay out", exact: true }).click(); await typeDigits(page, "3200"); await page.getByRole("combobox", { name: "Reason" }).click(); await page.getByRole("option", { name: "Courier" }).click(); await page.getByRole("button", { name: /^Record pay out/ }).click();
    await expect(page.getByTestId("cash-list")).toContainText("Pay out");
    await toClose(page);
    await count(page, "A\\$100", 4); await count(page, "A\\$50", 1); await count(page, "A\\$20", 1); await count(page, "A\\$5", 1);   // 475.00; expected 150 + 342.95 - 32 = 460.95
    await expect(page.getByTestId("close-counted")).toHaveText("A$475.00");
    await expect(page.getByText("Expected in drawer")).toHaveCount(0);                                                // blind: nothing to tune the count against
    await page.getByRole("button", { name: "See the difference" }).click();
    await expect(page.getByTestId("z-variance")).toHaveText("14.05"); await shot(page, "close");
    await page.getByRole("button", { name: /Manager approval|Close without approval/ }).first().isVisible().catch(() => undefined);
    await expect(page.getByText(/past the A\$5\.00 limit/)).toBeVisible();
    await page.getByRole("button", { name: "Manager approval" }).click(); await approveWith(page, shop.manager, "Approve");
    await expect(page.getByText(`Approved by ${shop.manager.name}`)).toBeVisible();
    await page.getByRole("button", { name: "Close register", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Register closed" })).toBeVisible();
    await expect(page.getByTestId("final-variance")).toHaveText("14.05", { timeout: 30_000 }); await expect(page.getByText("Final")).toBeVisible(); await shot(page, "closed");
    const [s] = await sql(`select s.status, s.expected_close_minor, s.counted_close_minor, s.variance_minor, s.flags from shelfline.register_session s join shelfline.location l on l.id = s.location_id where l.code = $1`, [`S${shop.tag}`]);
    expect(s).toEqual({ status: "closed", expected_close_minor: 46095, counted_close_minor: 47500, variance_minor: 1405, flags: ["variance_approved"] });
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("a count within the limit closes without any approval and leaves no exception", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop);
    await toClose(page); await count(page, "A\\$100", 1); await count(page, "A\\$50", 1);                              // exactly the A$150.00 float
    await page.getByRole("button", { name: "See the difference" }).click(); await expect(page.getByTestId("z-variance")).toHaveText("0.00");
    await page.getByRole("button", { name: "Close register", exact: true }).click();
    await expect(page.getByTestId("final-variance")).toHaveText("0.00", { timeout: 30_000 });
    expect((await rows(`select count(*)::int as n from shelfline.sync_exception e join shelfline.location l on l.org_id = e.org_id where l.code = $1 and e.created_at > now() - interval '3 minutes' and e.kind = 'variance_over_limit' and (e.detail->>'expectedMinor') = '15000'`, shop))[0]!.n).toBe(0);
  });
});

test.describe("shift", () => {
  test("clock in and out are recorded with the cashier's PIN; the buttons follow the state", async ({ page }) => {
    const shop = await provisionShop(); await pairAndOpen(page, shop); await nav(page, "Shift");
    await expect(page.getByRole("button", { name: "Clock out" })).toBeDisabled();
    await page.getByRole("button", { name: "Clock in" }).click(); await expect(page.getByTestId("clock-state")).toContainText("Clocked in");
    await expect(page.getByRole("button", { name: "Clock in" })).toBeDisabled();
    await page.getByRole("button", { name: "Clock out" }).click(); await expect(page.getByTestId("clock-state")).toContainText("Clocked out");
    await expect.poll(async () => (await rows(`select count(*)::int as n from shelfline.punch p join shelfline.location l on l.id = p.location_id where l.code = $1`, shop))[0]!.n, { timeout: 30_000 }).toBe(2);
    expect(await rows(`select p.kind, p.method, p.status from shelfline.punch p join shelfline.location l on l.id = p.location_id where l.code = $1 order by p.client_ts`, shop)).toEqual([{ kind: "in", method: "pin", status: "accepted" }, { kind: "out", method: "pin", status: "accepted" }]);
  });
});
