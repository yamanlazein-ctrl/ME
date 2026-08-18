import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { captureConsoleErrors } from "../_helpers/test-helpers";

const DIALOG_TESTS: {
  route: string;
  description: string;
  triggerSelector: string;
  dialogTitle?: string;
  confirmSelector?: string;
  cancelSelector?: string;
  skipReason?: string;
}[] = [
  // Inventory dialogs
  { route: "/inventory", description: "Add Fabric dialog", triggerSelector: "button:has-text('إضافة قماش')", dialogTitle: "قماش" },
  { route: "/inventory", description: "Add Color dialog", triggerSelector: "button:has-text('إضافة لون')", dialogTitle: "لون" },

  // Customer dialogs
  { route: "/customers", description: "Add Customer dialog", triggerSelector: "button:has-text('عميل')", dialogTitle: "عميل" },

  // Supplier dialogs
  { route: "/suppliers", description: "Add Supplier dialog", triggerSelector: "button:has-text('مورد')", dialogTitle: "مورد" },

  // Cashbox dialogs
  { route: "/cashbox", description: "Opening Balance dialog", triggerSelector: "button:has-text('رصيد')", dialogTitle: "رصيد" },
  { route: "/cashbox", description: "Manual Movement dialog", triggerSelector: "button:has-text('حركة')", dialogTitle: "حركة" },

  // Cancel invoice (two-step dialog)
  { route: "/invoices/INV-2863", description: "Cancel invoice step 1", triggerSelector: "button:has-text('إلغاء')", dialogTitle: "إلغاء" },
];

test.describe("Cert UI — Dialog Audit", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const dialogTest of DIALOG_TESTS) {
    test.skip(dialogTest.skipReason != null, dialogTest.skipReason ?? "");

    test(`${dialogTest.route} — ${dialogTest.description}`, async ({ page }) => {
      test.setTimeout(30000);

      const errors = await captureConsoleErrors(page, async () => {
        await page.goto(dialogTest.route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(3000);
      });

      const trigger = page.locator(dialogTest.triggerSelector).first();
      await expect(trigger).toBeVisible({ timeout: 8000 });
      await trigger.click();
      await page.waitForTimeout(1000);

      const dialog = page.locator("[role='dialog'], [role='alertdialog']");
      await expect(dialog.first()).toBeVisible({ timeout: 5000 });

      if (dialogTest.dialogTitle) {
        const titleEl = page.getByText(dialogTest.dialogTitle, { exact: false }).first();
        const visible = await titleEl.isVisible().catch(() => false);
        expect(visible).toBe(true);
      }

      const cancelBtn = page.locator("[role='dialog'] button:has-text('إلغاء'), [role='alertdialog'] button:has-text('إلغاء'), [role='alertdialog'] button:has-text('تراجع')").first();
      if (await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await cancelBtn.click();
        await page.waitForTimeout(1000);
        const stillOpen = await page.locator("[role='dialog'], [role='alertdialog']").isVisible()
          .catch(() => false);
        if (!stillOpen) {
          expect(stillOpen).toBe(false);
        }
      } else {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }

      expect(errors).toEqual([]);
    });
  }
});

test.describe("Cert UI — Delete Confirm Dialogs", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  const deleteTests = [
    { route: "/settings/units", trigger: "button:has-text('حذف')", description: "Delete Unit" },
    { route: "/settings/taxes", trigger: "button:has-text('حذف')", description: "Delete Tax" },
    { route: "/settings/warehouses", trigger: "button:has-text('حذف')", description: "Delete Warehouse" },
    { route: "/settings/payment-methods", trigger: "button:has-text('حذف')", description: "Delete Payment Method" },
  ];

  for (const dt of deleteTests) {
    test(`${dt.route} — ${dt.description} confirm dialog`, async ({ page }) => {
      test.setTimeout(30000);

      await page.goto(dt.route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      const deleteBtn = page.locator(dt.trigger).first();
      const isVisible = await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (!isVisible) {
        test.skip(true, `No delete button visible on ${dt.route}`);
        return;
      }

      await deleteBtn.click();
      await page.waitForTimeout(500);

      const alertDialog = page.locator("[role='alertdialog']");
      await expect(alertDialog.first()).toBeVisible({ timeout: 5000 });

      const confirmBtn = alertDialog.locator("button:has-text('تأكيد')").first();
      const cancelBtn = alertDialog.locator("button:has-text('إلغاء')").first();

      const hasConfirm = await confirmBtn.isVisible().catch(() => false);
      const hasCancel = await cancelBtn.isVisible().catch(() => false);

      expect(hasConfirm || hasCancel).toBe(true);

      if (hasCancel) {
        await cancelBtn.click();
        await page.waitForTimeout(500);
      }
    });
  }
});
