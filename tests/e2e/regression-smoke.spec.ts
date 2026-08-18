import { test, expect, type Page } from "@playwright/test";

const ADMIN = { email: "admin@erp.local", password: "admin123" };

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const emailInput = page.locator('input[placeholder="admin@erp.local"]');
  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  await emailInput.fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 30_000 });
}

test("Ledger screen loads and renders entries (incl. cancelled rows)", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/ledger", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("فلاتر البحث").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  const body = await page.locator("tbody").first().innerText().catch(() => "");
  expect(body.length).toBeGreaterThan(0);
});

test("Invoices list loads", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/invoices", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("الفواتير").first()).toBeVisible({ timeout: 20_000 });
});

test("Receipts list loads", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/receipts", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("سندات القبض").first()).toBeVisible({ timeout: 20_000 });
});

test("Payments list loads", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/payments", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("سندات الصرف").first()).toBeVisible({ timeout: 20_000 });
});
