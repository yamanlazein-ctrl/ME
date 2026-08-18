/**
 * Visual verification of the new print design across ALL document types.
 */
import { test, expect } from "@playwright/test";

const PRINT_PREVIEW_DIR = "test-results/print-preview";
const SALE_INVOICE_ID = "767242c2-6f87-4e02-98d9-8e5f09ec1534";
const ENTRY_INVOICE_ID = "aeefbd99-120a-40d1-a1c3-b35360827c18";
const CUSTOMER_ID = "63270964-77b3-494d-9308-5015ef93bd4a";

/** Wait for the login form to be fully gone, i.e. we're inside the app. */
async function waitForApp(page: import("@playwright/test").Page) {
  // The AppShell renders the side nav with a لوحة التحكم entry
  const navLink = page.locator("text=لوحة التحكم").first();
  await navLink.waitFor({ state: "visible", timeout: 20_000 });
}

test.describe("Print Preview — Visual Verification (All Doc Types)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Wait for the page to settle
    await page.waitForTimeout(2000);
    const usernameInput = page
      .locator('input[name="username"], input[type="text"]')
      .first();
    const isLogin = await usernameInput.isVisible({ timeout: 5_000 }).catch(() => false);
    if (isLogin) {
      await usernameInput.fill("admin@erp.local");
      await page.locator('input[type="password"]').first().fill("admin123");
      await page.locator('button[type="submit"]').click();
      await waitForApp(page);
    }
  });

  async function renderAndSnap(
    page: import("@playwright/test").Page,
    docName: string,
    route: string,
    triggerSelector: string,
  ) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // If we got bounced to login, log in and retry once
    if (await page.locator('input[type="password"]').first().isVisible({ timeout: 1500 }).catch(() => false)) {
      await page.locator('input[name="username"], input[type="text"]').first().fill("admin@erp.local");
      await page.locator('input[type="password"]').first().fill("admin123");
      await page.locator('button[type="submit"]').click();
      await waitForApp(page);
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
    }

    await page.evaluate(() => {
      window.print = () => {};
    });

    const btn = page.locator(triggerSelector).first();
    const ok = await btn.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!ok) {
      const html = await page.content();
      const file = `test-results/print-preview-snap-${docName}.html`;
      await page.evaluate((f) => {
        // expose for debugging
      }, file);
      require("node:fs").writeFileSync(file, html);
      throw new Error(`Print button not visible at ${route} (selector: ${triggerSelector})`);
    }
    await btn.click();
    await page.waitForTimeout(1500);

    const printRoot = page.locator("[data-print-root]");
    await printRoot.first().waitFor({ state: "visible", timeout: 10_000 });

    await page.addStyleTag({
      content: `
        body > *:not([data-print-root]) { display: none !important; }
        [data-print-root] {
          position: static !important;
          display: block !important;
          background: #fff !important;
        }
      `,
    });
    await page.waitForTimeout(400);

    await printRoot.first().screenshot({
      path: `${PRINT_PREVIEW_DIR}/${docName}.png`,
    });
  }

  test("01 Sale Invoice — فاتورة بيع", async ({ page }) => {
    await renderAndSnap(
      page,
      "01-sale-invoice",
      `/invoices/${SALE_INVOICE_ID}`,
      "button:has(svg.lucide-printer)",
    );
  });

  test("02 Entry Invoice — فاتورة شراء", async ({ page }) => {
    await renderAndSnap(
      page,
      "02-entry-invoice",
      `/invoices/${ENTRY_INVOICE_ID}`,
      "button:has(svg.lucide-printer)",
    );
  });

  test("03 Return Invoice — مرتجع", async ({ page }) => {
    await renderAndSnap(
      page,
      "03-return-invoice",
      "/returns",
      "button[title*='طباعة المرتجع']",
    );
  });

  test("04 Party Statement — كشف حساب عميل", async ({ page }) => {
    await renderAndSnap(
      page,
      "04-party-statement-customer",
      `/customers/${CUSTOMER_ID}`,
      "button:has-text('طباعة')",
    );
  });
});
