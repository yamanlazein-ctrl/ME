import { test, expect } from "@playwright/test";

const BASE = "http://localhost:5173";

test.describe("return add-color button (conditional)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("adding a line + picking a roll shows the add-color button", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill('input[autocomplete="username"]', "admin@erp.local");
    await page.fill('input[type="password"]', "admin123");
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
    await page.waitForSelector('nav[aria-label="القائمة الجانبية"]', { timeout: 15000 }).catch(() => {});

    await page.goto(`${BASE}/returns/entry/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    // Click "إضافة بند"
    await page.locator('button:has-text("إضافة بند")').first().click();
    await page.waitForTimeout(500);

    // Expect one row with a roll select (placeholder "اختر صبغة")
    const rollSelect = page.locator('button:has-text("اختر صبغة")').first();
    await rollSelect.click();
    await page.waitForTimeout(500);
    // Pick the first roll option in the dropdown
    const firstOption = page.locator('[role="option"]').first();
    await firstOption.click().catch(() => {});
    await page.waitForTimeout(700);

    // Now palette/add-color button (aria-label "إضافة لون آخر لنفس القماش") should appear
    const addColorBtn = await page.locator('button[aria-label*="إضافة لون آخر"]').count();
    const paletteBtn = await page.locator('button:has(.lucide-palette)').count();
    console.log("return add-color (aria):", addColorBtn, " (palette icon):", paletteBtn);

    await page.screenshot({ path: "test-results/return-after-roll.png", fullPage: false });

    expect(addColorBtn + paletteBtn).toBeGreaterThan(0);
  });
});
