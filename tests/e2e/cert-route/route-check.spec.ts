import { test, expect } from "@playwright/test";
import { loginIfNeeded } from "../_helpers/login";
import { assertRouteOk } from "../_helpers/test-helpers";

const STATIC_ROUTES = [
  { path: "/", title: "لوحة التحكم" },
  { path: "/cashbox", title: "الصندوق" },
  { path: "/expenses", title: "المصاريف" },
  { path: "/expenses/new", title: "مصروف جديد" },
  { path: "/inventory", title: "المخزون" },
  { path: "/invoices", title: "الفواتير" },
  { path: "/invoices/entry/new", selector: "text=فاتورة دخول" },
  { path: "/invoices/sale/new", selector: "text=فاتورة بيع" },
  { path: "/invoices/print-send/new", title: "إرسال إلى المطبعة" },
  { path: "/invoices/print-receive/new", title: "استلام من المطبعة" },
  { path: "/ledger", title: "دفتر الحركات المركزي" },
  { path: "/orders", title: "الطلبات" },
  { path: "/orders/new", title: "طلب جديد" },
  { path: "/payments", title: "سندات الصرف" },
  { path: "/payments/new", title: "سند صرف جديد" },
  { path: "/receipts", title: "سندات القبض" },
  { path: "/receipts/new", title: "سند قبض جديد" },
  { path: "/returns", title: "المرتجعات" },
  { path: "/returns/entry/new", title: "مرتجع دخول جديد" },
  { path: "/returns/sale/new", title: "مرتجع بيع جديد" },
  { path: "/customers", title: "العملاء" },
  { path: "/suppliers", title: "الموردون" },
  { path: "/reports", title: "التقارير" },
  { path: "/print-center", title: "مركز الطباعة" },
  { path: "/settings", title: "الإعدادات" },
  { path: "/settings/activity", title: "سجل النشاط" },
  { path: "/settings/audit", title: "التدقيق" },
  { path: "/settings/backup", title: "النسخ الاحتياطي" },
  { path: "/settings/company", title: "معلومات الشركة" },
  { path: "/settings/currencies", title: "العملات" },
  { path: "/settings/payment-methods", title: "طرق الدفع" },
  { path: "/settings/printing", title: "إعدادات الطباعة" },
  { path: "/settings/taxes", title: "الضرائب" },
  { path: "/settings/units", title: "الوحدات" },
  { path: "/settings/users", title: "المستخدمون والصلاحيات" },
  { path: "/settings/warehouses", title: "المستودعات" },
];

const REPORT_SLUGS = [
  "net-sales", "purchases", "cashbox", "inventory-value",
  "receivables", "payables", "sales-returns", "expenses",
  "top-fabrics", "top-customers",
];

test.describe("Cert Route — Static Routes", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const route of STATIC_ROUTES) {
    test(`${route.path} — loads without crash`, async ({ page }) => {
      test.setTimeout(20000);

      const { errors } = await assertRouteOk(page, route.path);

      if (route.title) {
        await expect(page.getByText(route.title, { exact: false }).first()).toBeVisible({
          timeout: 8000,
        });
      } else if (route.selector) {
        await expect(page.locator(route.selector).first()).toBeVisible({ timeout: 8000 });
      }

      expect(errors).toEqual([]);
    });
  }

  for (const slug of REPORT_SLUGS) {
    test(`/reports/${slug} — loads without crash`, async ({ page }) => {
      test.setTimeout(20000);

      const { errors } = await assertRouteOk(page, `/reports/${slug}`);
      await expect(page.getByText("تقرير", { exact: false }).first()).toBeVisible({
        timeout: 8000,
      });
      expect(errors).toEqual([]);
    });
  }
});

test.describe("Cert Route — Dynamic Routes", () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  test("/invoices/$id — seed invoice loads", async ({ page }) => {
    test.setTimeout(20000);
    const { errors } = await assertRouteOk(page, "/invoices/INV-2863");
    await expect(page.getByText("فاتورة", { exact: false }).first()).toBeVisible({
      timeout: 8000,
    });
    expect(errors).toEqual([]);
  });

  test("/orders/$id — seed order loads if exists", async ({ page }) => {
    test.setTimeout(20000);
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const link = page.locator("a").filter({ hasText: "طلب" }).first();
    const href = await link.getAttribute("href").catch(() => null);
    if (href && href.includes("/orders/")) {
      const { errors } = await assertRouteOk(page, href);
      await expect(page.getByText("طلب", { exact: false }).first()).toBeVisible({
        timeout: 8000,
      });
      expect(errors).toEqual([]);
    } else {
      test.skip(true, "No order link found for dynamic route test");
    }
  });

  test("/customers/$id — seed customer loads", async ({ page }) => {
    test.setTimeout(20000);
    const { errors } = await assertRouteOk(page, "/customers/cus-1");
    await expect(page.getByText("خالد الأحمد", { exact: false }).first()).toBeVisible({
      timeout: 8000,
    });
    expect(errors).toEqual([]);
  });

  test("/suppliers/$id — seed supplier loads", async ({ page }) => {
    test.setTimeout(20000);
    const { errors } = await assertRouteOk(page, "/suppliers/sup-1");
    await expect(
      page.getByText("الشركة السورية للنسيج", { exact: false }).first(),
    ).toBeVisible({ timeout: 8000 });
    expect(errors).toEqual([]);
  });
});
