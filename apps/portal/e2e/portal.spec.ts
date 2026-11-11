import { expect, test, type Page } from "@playwright/test";
import { http, openSession, ownerToken, provisionWorld, sell, sql } from "../../admin/e2e/fixtures";

const shot = (page: Page, name: string) => page.screenshot({ path: `../../.impeccable/review/portal-${name}.png` });
const mailCode = async (email: string) => { const box = (await http<{ subject: string }[]>("GET", `/dev/mailbox?to=${encodeURIComponent(email)}`, null)).body; return /(\d{6})/.exec(box.find((m: any) => m.kind === "portal_code")!.subject)![1]!; };
async function signIn(page: Page, email: string) {
  await page.goto("/"); await page.getByLabel("Email").fill(email); await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByRole("status")).toContainText("a 6-digit code is on its way");
  await page.getByLabel("Code").fill(await mailCode(email)); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible();
}

test("an accountant signs in with a code, sees only what was granted, downloads it, and loses access when it is withdrawn", async ({ page }) => {
  const w = await provisionWorld(); const [a, b] = w.stores as [typeof w.stores[0], typeof w.stores[0]]; const owner = await ownerToken();
  await openSession(a!, w); await openSession(b!, w);
  expect((await sell(a!, w, [{ v: 0, qty: 1 }], "card")).status).toBe(200); expect((await sell(b!, w, [{ v: 1, qty: 3 }], "card")).status).toBe(200);        // A$219.95 at Fitzroy, A$267.00 at the other store
  const email = `ines.${a!.tag.toLowerCase()}@accounts.test`;
  const g = await http("POST", "/report-grants", owner, { email, name: "Ines Walker", reportKeys: ["sales", "cash_variance"], locationIds: [a!.id], rangeKind: "rolling", rollingDays: 30, hiddenColumns: ["costMinor"] }); expect(g.status).toBe(201);

  // S60: a wrong code is refused first
  await page.goto("/"); await expect(page.getByRole("heading", { name: "Shelfline Reports" })).toBeVisible(); await shot(page, "sign-in");
  await page.getByLabel("Email").fill(email); await page.getByRole("button", { name: "Send me a code" }).click(); await page.getByLabel("Code").fill("000000"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not right"); await shot(page, "code");
  await page.getByLabel("Code").fill(await mailCode(email)); await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // S61: what was given, in plain words
  await expect(page.getByRole("heading", { name: "My reports" })).toBeVisible(); const card = page.getByTestId("grant").first();
  await expect(card).toContainText("Sales · Cash variance"); await expect(card).toContainText(a!.name); await expect(card).not.toContainText(b!.name); await expect(card).toContainText("Last 30 days"); await expect(card).toContainText("cost columns hidden"); await shot(page, "my-reports");

  // S62: the scope stays on screen; only the granted store and no cost columns
  await card.getByRole("link", { name: "Open Sales" }).click(); const banner = page.getByTestId("scope-banner"); await expect(banner).toContainText(a!.name); await expect(banner).toContainText("cost columns hidden");
  const table = page.getByTestId("report-table"); await expect(table).toContainText("Net"); await expect(table).not.toContainText("Cost of goods"); await expect(table).not.toContainText("Margin"); await expect(table).toContainText("219.95"); await expect(page.locator("body")).not.toContainText("267.00");
  await page.getByRole("radio", { name: "Location" }).click(); await expect(table).toContainText(a!.name); await expect(table).not.toContainText(b!.name); await shot(page, "viewer");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download CSV/ }).click()]); const fs = await import("node:fs"); const csv = fs.readFileSync(await dl.path(), "utf8");
  expect(csv.split("\n")[0]).toBe("Location,Orders,Items,Gross,Discounts,Refunds,Net,GST included"); expect(csv).toContain(a!.name); expect(csv).not.toContain(b!.name); expect(csv).not.toMatch(/Cost|Margin/);
  await page.getByRole("link", { name: /My reports/ }).first().click(); await card.getByRole("link", { name: "Open Cash variance" }).click(); await expect(page.getByRole("heading", { name: "Cash variance" })).toBeVisible();

  // the same on a phone: nothing spills sideways
  await page.setViewportSize({ width: 390, height: 844 }); await page.goBack(); await page.getByTestId("grant").first().getByRole("link", { name: "Open Sales" }).click(); await expect(page.getByTestId("scope-banner")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await shot(page, "viewer-phone"); await page.setViewportSize({ width: 1280, height: 860 });

  // the back office logs what was opened; then access is withdrawn
  const views = await sql(`select report_key, format, row_count::int as n from shelfline.report_view_log order by id`); expect(views.length).toBeGreaterThanOrEqual(3); expect(views[0]).toMatchObject({ report_key: "sales" });
  const grants = (await http<any[]>("GET", "/report-grants", owner)).body; expect((await http("POST", `/report-grants/${grants.find((x) => x.email === email).id}/revoke`, owner)).status).toBe(200);
  await page.goto("/"); await expect(page.getByText("Access ended").first()).toBeVisible(); await expect(page.getByTestId("grant").first()).toContainText("Given by Owner"); await shot(page, "ended");
  await page.goto(`/#/g/${grants.find((x) => x.email === email).id}/sales`); await expect(page.getByRole("heading", { name: "Access ended" })).toBeVisible(); await expect(page.locator("body")).toContainText("Owner");
});

test("a stranger gets the same answer as a reader, and a portal token opens nothing in the back office", async ({ page, request }) => {
  const w = await provisionWorld({ stores: 1 }); void w;
  await page.goto("/"); await page.getByLabel("Email").fill("nobody@nowhere.test"); await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByRole("status")).toContainText("a 6-digit code is on its way");                       // no hint that the address is unknown
  expect((await http<any[]>("GET", "/dev/mailbox?to=nobody@nowhere.test", null)).body).toEqual([]);
  const owner = await ownerToken(); const email = `reader.${Date.now()}@accounts.test`;
  expect((await http("POST", "/report-grants", owner, { email, reportKeys: ["sales"], locationIds: null, rangeKind: "rolling", rollingDays: 7, hiddenColumns: [] })).status).toBe(201);
  const verify = await request.post("http://localhost:8201/portal/auth/request-code", { data: { email } }); expect(verify.status()).toBe(204);
  const code = await mailCode(email); const tok = (await (await request.post("http://localhost:8201/portal/auth/verify", { data: { email, code } })).json()).token as string;
  for (const u of ["/report-grants", "/users", "/commission/rules", "/reports/sales?from=2026-01-01&to=2026-12-31"]) expect((await request.get(`http://localhost:8201${u}`, { headers: { authorization: `Bearer ${tok}` } })).status()).toBe(401);
});
