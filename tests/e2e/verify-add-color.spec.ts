import { test, expect } from "@playwright/test";

const BASE = "http://localhost:5173";

test.describe("add-color-per-fabric button presence", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("login and verify palette/add-color buttons on invoice pages", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());

    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill('input[autocomplete="username"]', "admin@erp.local");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
    await page.waitForSelector('nav[aria-label="القائمة الجانبية"]', { timeout: 15000 }).catch(() => {});
    expect(page.url()).not.toContain("/login");

    // Entry invoice: fill a fabric row so the palette button appears
    await page.goto(`${BASE}/invoices/entry/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const fabricInput = page.locator('input[aria-label="القماش"]').first();
    if ((await fabricInput.count()) > 0) {
      await fabricInput.fill("قطن مصري");
      await page.waitForTimeout(700);
      await page.locator('button:has-text("قطن مصري")').first().click().catch(() => {});
      await page.waitForTimeout(700);
    }
    const entryPalette = await page.locator('button[title*="إضافة لون"], button:has(.lucide-palette)').count();
    console.log("entry palette:", entryPalette);

    // Sale invoice: fill fabric then palette appears
    await page.goto(`${BASE}/invoices/sale/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    // SaleLineCard has its own fabric input; count palette initially
    let salePalette = await page.locator('button:has(.lucide-palette)').count();
    console.log("sale palette (initial):", salePalette);
    // Try to fill a sale fabric input if present
    const saleFabric = page.locator('input[aria-label*="قماش"], input[placeholder*="قماش"]').first();
    if ((await saleFabric.count()) > 0) {
      await saleFabric.fill("قطن مصري");
      await page.waitForTimeout(700);
      await page.locator('button:has-text("قطن مصري")').first().click().catch(() => {});
      await page.waitForTimeout(700);
      salePalette = await page.locator('button:has(.lucide-palette)').count();
      console.log("sale palette (after fill):", salePalette);
    }

    // Returns entry: fill + palette
    await page.goto(`${BASE}/returns/entry/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const retEntryPalette = await page.locator('button:has(.lucide-palette)').count();
    console.log("return-entry palette:", retEntryPalette);

    await page.goto(`${BASE}/returns/sale/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const retSalePalette = await page.locator('button:has(.lucide-palette)').count();
    console.log("return-sale palette:", retSalePalette);

    // Print-send/receive: palette should be absent (single document)
    await page.goto(`${BASE}/invoices/print-send/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const psPalette = await page.locator('button:has(.lucide-palette)').count();
    console.log("print-send palette:", psPalette);

    await page.goto(`${BASE}/invoices/print-receive/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const prPalette = await page.locator('button:has(.lucide-palette)').count();
    console.log("print-receive palette:", prPalette);

    const results = {
      "entry": entryPalette >= 1,
      "sale": salePalette >= 1,
      "return-entry": retEntryPalette >= 1,
      "return-sale": retSalePalette >= 1,
      "print-send-absent": psPalette === 0,
      "print-receive-absent": prPalette === 0,
    };
    console.log("RESULTS:", JSON.stringify(results, null, 2));

    expect(results.entry).toBe(true);
    expect(results.sale).toBe(true);
    expect(results["return-entry"]).toBe(true);
    expect(results["return-sale"]).toBe(true);
    expect(results["print-send-absent"]).toBe(true);
    expect(results["print-receive-absent"]).toBe(true);
  });
});
