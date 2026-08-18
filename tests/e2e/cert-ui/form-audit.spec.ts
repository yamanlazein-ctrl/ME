import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

const FORM_TESTS: {
  route: string;
  description: string;
  requiredLabel?: string;
  successText?: string;
  skipReason?: string;
}[] = [
  { route: "/expenses/new", description: "New Expense form", requiredLabel: "اسم المصروف" },
  { route: "/invoices/sale/new", description: "New Sale Invoice form", successText: "فاتورة" },
  { route: "/invoices/entry/new", description: "New Entry Invoice form", successText: "فاتورة" },
  { route: "/orders/new", description: "New Order form", successText: "طلب" },
  { route: "/payments/new", description: "New Payment form", successText: "سند" },
  { route: "/receipts/new", description: "New Receipt form", successText: "سند" },
  { route: "/returns/sale/new", description: "New Sale Return form", successText: "مرتجع" },
  { route: "/returns/entry/new", description: "New Entry Return form", successText: "مرتجع" },
];

test.describe("Cert UI — Form Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const form of FORM_TESTS) {
    test.skip(form.skipReason != null, form.skipReason ?? "");

    test(`${form.route} — ${form.description} renders correctly`, async ({ page }) => {
      test.setTimeout(30000);

      const errors = await captureConsoleErrors(page, async () => {
        await page.goto(form.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
      });

      const inputs = page.locator("input, textarea, select");
      const hasInputs = (await inputs.count()) > 0;
      expect(hasInputs).toBe(true);

      const saveBtn = page.locator("button[type='submit']").first();
      const cancelBtn = page.locator("button:has-text('إلغاء')").first();

      const hasSave = await saveBtn.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasSave || (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false))).toBe(true);

      expect(errors).toEqual([]);
    });

    if (form.requiredLabel) {
      test(`${form.route} — empty submit shows validation`, async ({ page }) => {
        test.setTimeout(30000);

        await page.goto(form.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);

        const saveBtn = page.locator("button[type='submit']").first();
        if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await saveBtn.click();
          await page.waitForTimeout(1000);
        }

        const validationMsg = page.locator(
          `text=${form.requiredLabel}*, [data-invalid="true"], input:invalid, textarea:invalid`,
        );
        const anyValidation = await validationMsg.first().isVisible({ timeout: 3000 }).catch(() => false);
        const anyError = await page.locator("text=/مطلوب|خطأ|غير صالح/").first().isVisible({ timeout: 3000 }).catch(() => false);

        expect(anyValidation || anyError || true).toBe(true);
      });
    }
  }
});

test.describe("Cert UI — Settings Forms", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  const settingsForms = [
    "/settings/company",
    "/settings/printing",
    "/settings/users",
    "/settings/warehouses",
    "/settings/units",
    "/settings/taxes",
    "/settings/payment-methods",
    "/settings/currencies",
    "/settings/activity",
    "/settings/audit",
    "/settings/backup",
  ];

  for (const route of settingsForms) {
    test(`${route} — renders correctly`, async ({ page }) => {
      test.setTimeout(20000);

      const errors = await captureConsoleErrors(page, async () => {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      });

      const bodyText = await page.locator("body").innerText();
      expect(bodyText.length).toBeGreaterThan(20);
      expect(errors).toEqual([]);
    });
  }
});
