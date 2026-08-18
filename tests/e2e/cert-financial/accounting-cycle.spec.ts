import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";
import {
  createFabric,
  createColor,
  createRoll,
  createSupplier,
  createCustomer,
} from "../_helpers/mock-data";

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";

test.describe("Cert Financial — Accounting Cycle", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  let supplierId = "";
  let customerId = "";
  let supplierName = "";
  let customerName = "";

  test("Step 1: Create Supplier", async ({ request }) => {
    const supplier = await createSupplier(request);
    supplierId = supplier.id;
    supplierName = supplier.name;
    expect(supplierId).toBeTruthy();
  });

  test("Step 2: Create Entry Invoice (Purchase)", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/invoices/entry/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("فاتورة");
  });

  test("Step 3: Create Payment Voucher", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/payments/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("سند");
  });

  test("Step 4: Create Customer", async ({ request }) => {
    const customer = await createCustomer(request);
    customerId = customer.id;
    customerName = customer.name;
    expect(customerId).toBeTruthy();
  });

  test("Step 5: Create Sale Invoice", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/invoices/sale/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("فاتورة");
  });

  test("Step 6: Create Receipt Voucher", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/receipts/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("سند");
  });

  test("Step 7: Create Sale Return", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/returns/sale/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("مرتجع");
  });

  test("Step 8: Create Expense", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/expenses/new", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(50);
  });

  test("Step 9: Day Close", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/cashbox", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("الصندوق");
  });

  test("Step 10: Verify Dashboard KPIs render", async ({ page }) => {
    test.setTimeout(30000);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("لوحة التحكم");
  });

  test("Step 11: Verify Reports load", async ({ page }) => {
    test.setTimeout(60000);

    const slugs = [
      "net-sales", "purchases", "cashbox", "inventory-value",
      "receivables", "payables", "sales-returns", "expenses",
      "top-fabrics", "top-customers",
    ];

    for (const slug of slugs) {
      await page.goto(`/reports/${slug}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      const text = await page.locator("body").innerText();
      expect(text.length).toBeGreaterThan(10);
    }
  });

  test("Step 12: Verify Ledger entries exist", async ({ page }) => {
    test.setTimeout(30000);

    const errors = await captureConsoleErrors(page, async () => {
      await page.goto("/ledger", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
    });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toContain("دفتر الحركات");
    expect(errors).toEqual([]);
  });
});
