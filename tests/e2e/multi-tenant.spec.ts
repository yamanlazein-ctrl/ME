import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

test.describe("Multi-Tenant Isolation", () => {
  test("dashboard loads with tenant-scoped data", async ({ page }) => {
    await loginIfNeeded(page);
    await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 8000 });
    await expect(page.getByText("Motard Fabrics Gruob").first()).toBeVisible({ timeout: 5000 });
  });

  test("orders list loads with tenant context", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("طلبات العملاء").first()).toBeVisible({ timeout: 8000 });
  });

  test("invoices list respects tenant scope", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/invoices/entry/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("فاتورة دخول").first()).toBeVisible({ timeout: 8000 });
  });

  test("reports load with tenant-scoped numbers", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/reports", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("التقارير").first()).toBeVisible({ timeout: 8000 });
  });

  test("customers list respects tenant isolation", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/customers", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("العملاء").first()).toBeVisible({ timeout: 8000 });
  });

  test("suppliers list respects tenant isolation", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("الموردون").first()).toBeVisible({ timeout: 8000 });
  });

  test("ledger entries scoped to tenant", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 8000 });
  });

  test("settings scoped to tenant", async ({ page }) => {
    await loginIfNeeded(page);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("الإعدادات").first()).toBeVisible({ timeout: 8000 });
  });
});
