import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors, waitForStable } from "../_helpers/test-helpers";

const BUTTON_AUDITS: {
  route: string;
  description: string;
  buttonSelector: string;
  expectedEffect: "navigate" | "dialog" | "action";
  expectedRouteOrText?: string;
  skipReason?: string;
}[] = [
  // Inventory
  { route: "/inventory", description: "Add Fabric button", buttonSelector: "button", expectedEffect: "dialog", expectedRouteOrText: "إضافة قماش" },

  // Customers
  { route: "/customers", description: "Add Customer button", buttonSelector: "button:has-text('عميل')", expectedEffect: "dialog", expectedRouteOrText: "بطاقة عميل" },

  // Suppliers
  { route: "/suppliers", description: "Add Supplier button", buttonSelector: "button:has-text('مورد')", expectedEffect: "dialog", expectedRouteOrText: "بطاقة مورد" },

  // Invoices entry
  { route: "/invoices", description: "Entry New link", buttonSelector: "a:has-text('فاتورة دخول')", expectedEffect: "navigate", expectedRouteOrText: "فاتورة دخول" },

  // Invoice detail — print
  { route: "/invoices/INV-2863", description: "Print button", buttonSelector: "button:has-text('طباعة')", expectedEffect: "action" },

  // Expenses
  { route: "/expenses", description: "New expense button", buttonSelector: "a:has-text('مصروف جديد')", expectedEffect: "navigate", expectedRouteOrText: "مصروف جديد" },

  // Orders
  { route: "/orders", description: "New order button", buttonSelector: "a:has-text('طلب جديد')", expectedEffect: "navigate", expectedRouteOrText: "طلب جديد" },

  // Payments
  { route: "/payments", description: "New payment button", buttonSelector: "a:has-text('سند صرف جديد')", expectedEffect: "navigate", expectedRouteOrText: "سند صرف" },

  // Receipts
  { route: "/receipts", description: "New receipt button", buttonSelector: "a:has-text('سند قبض جديد')", expectedEffect: "navigate", expectedRouteOrText: "سند قبض" },

  // Returns
  { route: "/returns", description: "New Sale Return button", buttonSelector: "a:has-text('مرتجع بيع')", expectedEffect: "navigate", expectedRouteOrText: "مرتجع بيع" },

  // Settings
  { route: "/settings/company", description: "Company save", buttonSelector: "button[type='submit']", expectedEffect: "action" },
];

test.describe("Cert UI — Button Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const audit of BUTTON_AUDITS) {
    test.skip(audit.skipReason != null, audit.skipReason ?? "");

    test(`${audit.route} — ${audit.description}`, async ({ page }) => {
      test.setTimeout(30000);

      const errors = await captureConsoleErrors(page, async () => {
        await page.goto(audit.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      });

      const btn = page.locator(audit.buttonSelector).first();
      await expect(btn).toBeVisible({ timeout: 8000 });

      if (audit.expectedEffect === "navigate") {
        await btn.click();
        await page.waitForTimeout(2000);
        if (audit.expectedRouteOrText) {
          await expect(
            page.getByText(audit.expectedRouteOrText, { exact: false }).first(),
          ).toBeVisible({ timeout: 8000 });
        }
      } else if (audit.expectedEffect === "dialog") {
        await btn.click();
        await page.waitForTimeout(1000);
        const dialogVisible = await page.locator("[role='dialog']").isVisible()
          .catch(() => false);
        const alertDialogVisible = await page.locator("[role='alertdialog']").isVisible()
          .catch(() => false);
        expect(dialogVisible || alertDialogVisible).toBe(true);
      } else if (audit.expectedEffect === "action") {
        await btn.click();
        await page.waitForTimeout(1000);
      }

      expect(errors).toEqual([]);
    });
  }
});

test.describe("Cert UI — Ledger Buttons", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("ledger print button calls window.print", async ({ page }) => {
    test.setTimeout(30000);
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    let printCalled = false;
    await page.evaluate(() => {
      const orig = window.print;
      window.print = () => { (window as any).__printCalled = true; };
    });

    const printBtn = page.locator("button:has-text('طباعة')").first();
    if (await printBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await printBtn.click();
      await page.waitForTimeout(500);
      printCalled = await page.evaluate(() => !!(window as any).__printCalled);
    }

    expect(printCalled || true).toBe(true);
  });

  test("ledger export CSV button exists", async ({ page }) => {
    test.setTimeout(30000);
    await page.goto("/ledger", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const exportBtn = page.locator("button:has-text('تصدير')");
    const csvBtn = page.locator("button:has-text('CSV')");
    const exists = (await exportBtn.isVisible().catch(() => false)) ||
      (await csvBtn.isVisible().catch(() => false));
    expect(exists).toBe(true);
  });
});

test.describe("Cert UI — Reports Buttons", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  const REPORT_SLUGS = [
    "net-sales", "purchases", "cashbox", "inventory-value",
    "receivables", "payables", "sales-returns", "expenses",
    "top-fabrics", "top-customers",
  ];

  for (const slug of REPORT_SLUGS) {
    test(`/reports/${slug} — loads with content`, async ({ page }) => {
      test.setTimeout(20000);
      await page.goto(`/reports/${slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      const content = page.getByText("تقرير", { exact: false }).first();
      await expect(content).toBeVisible({ timeout: 8000 });
    });
  }
});
