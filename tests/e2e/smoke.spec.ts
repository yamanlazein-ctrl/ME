import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "./_helpers/login";

const ROUTES = [
  { path: "/", contains: "لوحة التحكم" },
  { path: "/orders", title: "طلبات العملاء" },
  { path: "/orders/new", selector: "text=طلب جديد" },
  { path: "/invoices/entry/new", selector: "text=فاتورة دخول" },
  { path: "/invoices/sale/new", selector: "text=فاتورة بيع" },
  { path: "/invoices/print-send/new", title: "إرسال إلى المطبعة" },
  { path: "/invoices/print-receive/new", title: "استلام من المطبعة" },
  { path: "/returns", title: "المرتجعات" },
  { path: "/returns/sale/new", title: "مرتجع بيع جديد" },
  { path: "/returns/entry/new", title: "مرتجع دخول جديد" },
  { path: "/payments", title: "سندات الصرف" },
  { path: "/payments/new", title: "سند صرف جديد" },
  { path: "/receipts", title: "سندات القبض" },
  { path: "/receipts/new", title: "سند قبض جديد" },
  { path: "/cashbox", contains: "الصندوق" },
  { path: "/ledger", title: "دفتر الحركات المركزي" },
  { path: "/expenses", title: "المصاريف" },
  { path: "/expenses/new", title: "مصروف جديد" },
  { path: "/inventory", title: "المخزون" },
  { path: "/reports", title: "التقارير" },
  { path: "/customers", title: "العملاء" },
  { path: "/suppliers", title: "الموردون" },
  { path: "/settings", title: "الإعدادات" },
  { path: "/settings/company", title: "معلومات الشركة" },
  { path: "/settings/users", title: "المستخدمون والصلاحيات" },
  { path: "/print-center", title: "مركز الطباعة" },
];

test.describe("Smoke Test — All Routes", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const route of ROUTES) {
    test(`${route.path} — loads without crash`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.goto(route.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      if (route.title) {
        await expect(page.getByText(route.title, { exact: false }).first()).toBeVisible({ timeout: 8000 });
      } else if (route.selector) {
        await expect(page.locator(route.selector).first()).toBeVisible({ timeout: 8000 });
      } else if (route.contains) {
        await expect(page.locator("body")).toContainText(route.contains, { timeout: 8000 });
      }

      const whiteScreen = await page.evaluate(() => {
        const body = document.body;
        return !body || body.children.length === 0 || body.innerText.trim().length === 0;
      });
      expect(whiteScreen).toBe(false);

      const criticalErrors = consoleErrors.filter(
        (e) =>
          !e.includes("favicon") &&
          !e.includes("Failed to load resource") &&
          !e.includes("net::ERR_"),
      );
      expect(criticalErrors).toEqual([]);
    });
  }
});
