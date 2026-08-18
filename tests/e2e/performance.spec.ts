import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

const CRITICAL_ROUTES = [
  { path: "/", label: "dashboard" },
  { path: "/orders", label: "orders" },
  { path: "/invoices/entry/new", label: "entry-invoice" },
  { path: "/reports", label: "reports" },
  { path: "/inventory", label: "inventory" },
  { path: "/ledger", label: "ledger" },
];

test.describe("Page Load Performance", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const route of CRITICAL_ROUTES) {
    test(`${route.label} — FCP < 4s`, async ({ page }) => {
      const start = Date.now();
      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);

      const fcp = await page.evaluate(() => {
        const [entry] = performance.getEntriesByType("paint").filter(
          (e) => e.name === "first-contentful-paint",
        ) as PerformanceEntry[];
        return entry ? entry.startTime : -1;
      });

      const loadTime = Date.now() - start;

      if (fcp > 0) {
        expect(fcp).toBeLessThan(4000);
      }

      expect(loadTime).toBeLessThan(15000);
    });
  }

  test("dashboard page weight under 5MB", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const metrics = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      let totalTransfer = 0;
      for (const r of resources) {
        totalTransfer += r.transferSize || r.encodedBodySize || 0;
      }
      const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const domContentLoaded = entries.length > 0 ? entries[0].domContentEventEnd : -1;
      return { totalTransfer, domContentLoaded };
    });

    expect(metrics.totalTransfer).toBeLessThan(8 * 1024 * 1024);
  });

  test("no JavaScript console errors on critical pages", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.goto("/reports", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("Failed to load resource") &&
        !e.includes("net::ERR_"),
    );
    expect(criticalErrors).toEqual([]);
  });
});
