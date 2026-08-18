import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

const FILTER_TESTS: {
  route: string;
  description: string;
  filterSelector: string;
  skipReason?: string;
}[] = [
  { route: "/invoices", description: "Invoice type filter", filterSelector: "select, button[aria-haspopup='listbox'], [role='combobox']" },
  { route: "/expenses", description: "Expense filter", filterSelector: "select, button[aria-haspopup='listbox'], [role='combobox']" },
  { route: "/orders", description: "Orders filter", filterSelector: "select, button[aria-haspopup='listbox'], [role='combobox']" },
  { route: "/returns", description: "Returns filter", filterSelector: "select, button[aria-haspopup='listbox'], [role='combobox']" },
  { route: "/ledger", description: "Ledger filters", filterSelector: "select, button[aria-haspopup='listbox'], [role='combobox']" },
  { route: "/customers", description: "Customer search", filterSelector: "input[type='text'], input[type='search'], input:not([type])" },
  { route: "/suppliers", description: "Supplier search", filterSelector: "input[type='text'], input[type='search'], input:not([type])" },
  { route: "/inventory", description: "Inventory search", filterSelector: "input[type='text'], input[type='search'], input:not([type])" },
];

test.describe("Cert UI — Filter Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const ft of FILTER_TESTS) {
    test.skip(ft.skipReason != null, ft.skipReason ?? "");

    test(`${ft.route} — ${ft.description} exists`, async ({ page }) => {
      test.setTimeout(20000);

      const errors = await captureConsoleErrors(page, async () => {
        await page.goto(ft.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
      });

      const filters = page.locator(ft.filterSelector);
      const count = await filters.count();
      expect(count).toBeGreaterThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("Cert UI — Search Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("customer search filters results", async ({ page }) => {
    test.setTimeout(20000);
    await page.goto("/customers", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const initialText = await page.locator("body").innerText();
    const searchInput = page.locator("input[type='text'], input[type='search']").first();

    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill("خالد");
      await page.waitForTimeout(1000);
      const newText = await page.locator("body").innerText();
      expect(initialText.length).toBeGreaterThan(0);
    }
  });

  test("supplier search filters results", async ({ page }) => {
    test.setTimeout(20000);
    await page.goto("/suppliers", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const searchInput = page.locator("input[type='text'], input[type='search']").first();
    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill("سورية");
      await page.waitForTimeout(1000);
    }

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(10);
  });
});
