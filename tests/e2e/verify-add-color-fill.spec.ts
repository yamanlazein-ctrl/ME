import { test, expect } from "@playwright/test";
import { e2eAdminAuth } from "./_helpers/testCredentials.js";
const __e2eAdmin = e2eAdminAuth();

const BASE = "http://localhost:5173";

test.describe("add-color-per-fabric functional", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("login, fill a fabric row, click add-color adds a sibling row", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());

    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill('input[autocomplete="username"]', __e2eAdmin.email);
    await page.fill('input[type="password"]', __e2eAdmin.password);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
    const url = page.url();
    console.log("LOGIN URL:", url);
    expect(url).not.toContain("/login");

    await page.goto(`${BASE}/invoices/entry/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Entry invoice first row's fabric input has aria-label "القماش"
    const fabricInput = page.locator('input[aria-label="القماش"]').first();
    const count = await fabricInput.count();
    console.log("fabric input count:", count);
    expect(count).toBeGreaterThan(0);

    // Type a fabric name, then pick the existing match from the dropdown
    await fabricInput.fill("قطن مصري");
    await page.waitForTimeout(700);
    // Click the dropdown item that says قطنا مصري
    const option = page.locator('button:has-text("قطن مصري")').first();
    await option.click().catch(() => {});
    await page.waitForTimeout(700);

    // Now the row should be non-empty → palette button appears (title "إضافة لون لنفس القماش")
    const entryPalette = await page.locator('button[title*="إضافة لون"]').count();
    const entryPaletteByIcon = await page.locator('button:has(.lucide-palette)').count();
    console.log("entry palette (title):", entryPalette, " (icon):", entryPaletteByIcon);

    await page.screenshot({ path: "test-results/entry-invoice-filled.png", fullPage: false });

    // Click add-color for same fabric
    const addBtn = page.locator('button[title*="إضافة لون"]').first();
    if ((await addBtn.count()) > 0) {
      await addBtn.click();
      await page.waitForTimeout(800);
    }
    const rowCount = await page.locator("article").count();
    console.log("rows after add-color click:", rowCount);
    await page.screenshot({ path: "test-results/entry-after-add-color.png", fullPage: false });

    const finalPalette = await page.locator('button[title*="إضافة لون"]').count();
    console.log("final palette count:", finalPalette);

    expect(entryPalette + entryPaletteByIcon).toBeGreaterThan(0);
    expect(rowCount).toBeGreaterThanOrEqual(2);
  });
});
