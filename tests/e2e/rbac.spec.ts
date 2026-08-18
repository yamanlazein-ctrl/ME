import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

test.describe("RBAC — Admin Access", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("admin can access settings", async ({ page }) => {
    test.setTimeout(60000);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("الإعدادات").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access settings/users", async ({ page }) => {
    await page.goto("/settings/users", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("المستخدمون والصلاحيات").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access settings/company", async ({ page }) => {
    await page.goto("/settings/company", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("معلومات الشركة").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access all financial modules", async ({ page }) => {
    await page.goto("/invoices/entry/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("فاتورة دخول").first()).toBeVisible({ timeout: 8000 });

    await page.goto("/payments/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("سند صرف جديد").first()).toBeVisible({ timeout: 8000 });

    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access inventory", async ({ page }) => {
    test.setTimeout(60000);
    await page.goto("/inventory", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("المخزون").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access orders", async ({ page }) => {
    await page.goto("/orders/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("طلب جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("admin can access print-center", async ({ page }) => {
    await page.goto("/print-center", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("مركز الطباعة").first()).toBeVisible({ timeout: 8000 });
  });
});
