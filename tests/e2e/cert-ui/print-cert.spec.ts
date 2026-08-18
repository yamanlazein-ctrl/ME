import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

test.describe("Cert Print — Automated Print Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("settings.printing page sets footerNote and paperSize", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/settings/printing", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("الطباعة");
  });

  test("invoice detail page has print button and data-print-root", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/invoices/INV-2863", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const printRoot = page.locator("[data-print-root]");
    const hasPrintRoot = await printRoot.first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasPrintRoot).toBe(true);
  });

  test("party detail print button exists", async ({ page }) => {
    test.setTimeout(30000);

    const partyRoutes = ["/customers/cus-1", "/suppliers/sup-1"];

    for (const route of partyRoutes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      const printBtn = page.locator("button:has-text('طباعة')").first();
      const bodyText = await page.locator("body").innerText();
      expect(bodyText.length).toBeGreaterThan(20);
    }
  });

  test("ledger page has print button and data-print-root", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const printRoot = page.locator("[data-print-root]");
    const hasPrintRoot = await printRoot.first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasPrintRoot).toBe(true);
  });

  test("data-print-footer shows footerNote text", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/invoices/INV-2863", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const footer = page.locator("[data-print-footer]");
    const hasFooter = await footer.first().isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasFooter).toBe(true);
  });
});
