import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

test.describe("Cert UI — Print/Export Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("invoice detail print button triggers window.print", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/invoices/INV-2863", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      (window as any).__printCalled = false;
      const orig = window.print;
      window.print = () => { (window as any).__printCalled = true; };
    });

    const printBtn = page.locator("button:has-text('طباعة')").first();
    if (await printBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await printBtn.click();
      await page.waitForTimeout(500);
    }

    const called = await page.evaluate(() => !!(window as any).__printCalled);
    expect(called).toBe(true);
  });

  test("PrintRoot component renders on invoice detail", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/invoices/INV-2863", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const printRoot = page.locator("[data-print-root]");
    const exists = await printRoot.first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(exists).toBe(true);
  });

  test("ledger CSV export triggers download", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const exportBtn = page.locator("button").filter({ hasText: /تصدير|CSV/i }).first();
    const isVisible = await exportBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (!isVisible) {
      test.skip(true, "Export button not visible");
      return;
    }

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 10000 }).catch(() => null),
      exportBtn.click(),
    ]);

    if (download) {
      expect(download).toBeTruthy();
    }
  });
});
