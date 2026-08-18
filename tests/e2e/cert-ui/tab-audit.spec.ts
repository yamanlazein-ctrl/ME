import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

test.describe("Cert UI — Tab Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("settings sidebar tabs switch correctly", async ({ page }) => {
    test.setTimeout(40000);

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const settingsTabs = [
      "بيانات الشركة",
      "المستخدمون",
      "سجل النشاط",
      "الضرائب",
      "الوحدات",
      "المستودعات",
      "طرق الدفع",
      "العملات",
      "إعدادات الطباعة",
      "التدقيق",
      "النسخ الاحتياطي",
    ];

    for (const tabLabel of settingsTabs) {
      const link = page.locator(`a:has-text("${tabLabel}")`).first();
      const isVisible = await link.isVisible({ timeout: 3000 }).catch(() => false);
      if (!isVisible) continue;

      const errors = await captureConsoleErrors(page, async () => {
        await link.click();
        await page.waitForTimeout(1500);
      });

      const bodyText = await page.locator("body").innerText();
      expect(bodyText.length).toBeGreaterThan(20);
      expect(errors).toEqual([]);
    }
  });

  test("customer/supplier detail tabs exist (overview/invoices/payments)", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/customers/cus-1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const partyTabs = ["نظرة عامة", "الفواتير", "المدفوعات", "كشف حساب"];
    let foundTabs = 0;

    for (const tabText of partyTabs) {
      const tab = page.getByText(tabText, { exact: false }).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        foundTabs++;
      }
    }

    expect(foundTabs).toBeGreaterThan(0);
  });

  test("supplier detail page loads correctly", async ({ page }) => {
    test.setTimeout(20000);

    const errors = await captureConsoleErrors(page, async () => {
      await page.goto("/suppliers/sup-1", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });
});
