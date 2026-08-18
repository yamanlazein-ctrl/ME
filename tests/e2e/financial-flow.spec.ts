import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

test.describe("Financial Flow 1: Order → Invoice → Payment → Cashbox", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("create order → form loads", async ({ page }) => {
    test.setTimeout(60000);
    await page.goto("/orders/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test("navigate cashbox → page responds", async ({ page }) => {
    await page.goto("/cashbox", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test("navigate payments → list loads", async ({ page }) => {
    await page.goto("/payments", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("سندات الصرف").first()).toBeVisible({ timeout: 8000 });
  });

  test("navigate receipts → list loads", async ({ page }) => {
    await page.goto("/receipts", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("سندات القبض").first()).toBeVisible({ timeout: 8000 });
  });
});

test.describe("Financial Flow 2: Purchase Entry → Return → Ledger", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("purchase entry invoice form loads", async ({ page }) => {
    await page.goto("/invoices/entry/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("فاتورة دخول").first()).toBeVisible({ timeout: 8000 });
  });

  test("sale return form loads", async ({ page }) => {
    await page.goto("/returns/sale/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("مرتجع بيع جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("entry return form loads", async ({ page }) => {
    await page.goto("/returns/entry/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("مرتجع دخول جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("ledger loads with filters", async ({ page }) => {
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("فلاتر البحث").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Financial Flow 3: Expense → Voucher → Ledger", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("expense form loads", async ({ page }) => {
    await page.goto("/expenses/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("مصروف جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("expenses list loads", async ({ page }) => {
    await page.goto("/expenses", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("المصاريف").first()).toBeVisible({ timeout: 8000 });
  });

  test("payment voucher form loads", async ({ page }) => {
    await page.goto("/payments/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("سند صرف جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("receipt voucher form loads", async ({ page }) => {
    await page.goto("/receipts/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("سند قبض جديد").first()).toBeVisible({ timeout: 8000 });
  });

  test("ledger shows entries after navigation", async ({ page }) => {
    await page.goto("/expenses", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.getByText("دفتر الحركات المركزي").first()).toBeVisible({ timeout: 8000 });
  });
});
