import { test, expect, type Page } from "@playwright/test";
import { loginAsAdmin } from "./_helpers/login.js";

test("Ledger screen loads and renders entries (incl. cancelled rows)", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/ledger", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("فلاتر البحث").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  const body = await page
    .locator("tbody")
    .first()
    .innerText()
    .catch(() => "");
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
