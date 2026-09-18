import { test, expect } from "@playwright/test";
import { e2eAdminAuth } from "./_helpers/testCredentials.js";
const __e2eAdmin = e2eAdminAuth();

const BASE = "http://localhost:5173";

test.describe("dashboard today-invoices & session bar", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("dashboard shows فواتير اليوم count, today date, and session bar", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.fill('input[autocomplete="username"]', __e2eAdmin.email);
    await page.fill('input[type="password"]', __e2eAdmin.password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
    // Wait for dashboard hero card to render
    await page.waitForSelector('[data-od-id="hero-today-invoices"]', { timeout: 15000 }).catch(() => {});
    // Wait for the KPI grid too
    await page.waitForTimeout(2500);

    const body = await page.locator("body").innerText();

    // 1) Hero card title "فواتير اليوم"
    const hasTitle = body.includes("فواتير اليوم");
    // 2) "تاريخ اليوم" chip always present
    const hasTodayDateChip = body.includes("تاريخ اليوم");
    // 3) A date pattern DD-MM-YYYY should appear near the hero (from new Date())
    const datePattern = /\d{2}-\d{2}-\d{4}/;
    const hasDate = datePattern.test(body);
    // 4) The hero "فواتير اليوم" must show a NUMBER (0..n), never "—"
    const countMatch = body.match(/فواتير اليوم\s*\n?\s*([0-9]+)(?!\d)/);
    const heroCount = countMatch ? countMatch[1] : null;
    const hasNumericCount = heroCount !== null;
    // also reject a bare "—" right after the title
    const countIsDash = /فواتير اليوم\s*\n?\s*—/.test(body);

    // 5) Session status bar present (الجلسة غير مفتوحة / جلسة)
    const hasSessionBar = body.includes("الجلسة غير مفتوحة") || body.includes("الجلسة") || body.includes("افتتحت الجلسة");

    console.log("hasTitle:", hasTitle, "| hasTodayDateChip:", hasTodayDateChip, "| hasDate:", hasDate, "| heroCount:", heroCount, "| countIsDash:", countIsDash, "| hasSessionBar:", hasSessionBar);
    console.log("--- dashboard text excerpt ---");
    const idx = body.indexOf("فواتير اليوم");
    console.log(JSON.stringify(idx >= 0 ? body.slice(Math.max(0, idx - 60), idx + 160) : "(not found)"));

    await page.screenshot({ path: "test-results/dashboard-after.png", fullPage: true });

    // Assertions (lenient: presence, not exact Arabic word matching)
    expect(hasTitle).toBe(true); // hero title
    expect(hasTodayDateChip).toBe(true); // today date chip
    expect(hasDate).toBe(true); // a DD-MM-YYYY appears somewhere
    expect(hasNumericCount).toBe(true); // hero shows a number, not a dash
    expect(countIsDash).toBe(false);
    expect(hasSessionBar).toBe(true); // session status visible in the top bar
  });
});