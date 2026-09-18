import { test, expect } from "@playwright/test";
import { e2eAdminAuth } from "./_helpers/testCredentials.js";
const __e2eAdmin = e2eAdminAuth();

const BASE = "http://localhost:5173";

test.describe("demo data visible in UI", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("login and see seeded fabrics/customers/invoices", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.fill('input[autocomplete="username"]', __e2eAdmin.email);
    await page.fill('input[type="password"]', __e2eAdmin.password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
    await page.waitForSelector('nav[aria-label="القائمة الجانبية"]', { timeout: 15000 }).catch(() => {});
    console.log("logged in, url:", page.url());

    // Inventory page shows seeded fabrics
    await page.goto(`${BASE}/inventory`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    const hasFabric = body.includes("(اختبار) قطن سادة") || body.includes("قطن سادة");
    const rollShown = body.includes("RT-0001");
    console.log("inventory has test fabric:", hasFabric, "| roll RT-0001 shown:", rollShown);
    expect(hasFabric).toBe(true);

    // Customers page
    await page.goto(`${BASE}/customers`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const cBody = await page.locator("body").innerText();
    const hasCustomer = cBody.includes("محل الهدى") || cBody.includes("بوتيك الأصيل") || cBody.includes("دار المنسوجات");
    console.log("customers has test customer:", hasCustomer);
    expect(hasCustomer).toBe(true);

    // Invoices index shows numbers — wait for rows (React Query) to render
    await page.goto(`${BASE}/invoices`, { waitUntil: "load" });
    await page.waitForSelector("text=INV-2026", { timeout: 15000 }).catch(() => {});
    const iBody = await page.locator("body").innerText();
    const hasInv = iBody.includes("INV-2026-0041") || iBody.includes("INV-2026-0040") || iBody.includes("INV-2026");
    console.log("invoices shows INV numbers:", hasInv);
    expect(hasInv).toBe(true);
  });
});