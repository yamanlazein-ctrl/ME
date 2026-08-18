import { test, expect } from "@playwright/test";
import { loginAs, logout } from "../_helpers/login";
import { assertRouteOk } from "../_helpers/test-helpers";

type UserRole = "admin" | "accountant" | "warehouse" | "viewer";

const ROLE_ALLOWED_PATHS: Record<UserRole, string[]> = {
  admin: ["*"],
  accountant: [
    "/", "/invoices", "/returns", "/orders", "/receipts", "/payments",
    "/expenses", "/ledger", "/cashbox", "/reports", "/print-center",
    "/customers", "/suppliers",
  ],
  warehouse: ["/", "/inventory", "/invoices/entry", "/returns/entry", "/print-center"],
  viewer: ["/", "/inventory", "/customers", "/suppliers", "/reports"],
};

const ALL_ROUTES = [
  "/",
  "/cashbox",
  "/expenses",
  "/expenses/new",
  "/inventory",
  "/invoices",
  "/invoices/entry/new",
  "/invoices/sale/new",
  "/invoices/print-send/new",
  "/invoices/print-receive/new",
  "/ledger",
  "/orders",
  "/orders/new",
  "/payments",
  "/payments/new",
  "/receipts",
  "/receipts/new",
  "/returns",
  "/returns/entry/new",
  "/returns/sale/new",
  "/customers",
  "/suppliers",
  "/reports",
  "/print-center",
  "/settings",
  "/settings/activity",
  "/settings/audit",
  "/settings/backup",
  "/settings/company",
  "/settings/currencies",
  "/settings/payment-methods",
  "/settings/printing",
  "/settings/taxes",
  "/settings/units",
  "/settings/users",
  "/settings/warehouses",
];

const USERS: { name: string; role: UserRole; username: string; password: string }[] = [
  { name: "Warehouse", role: "warehouse", username: "warehouse", password: "warehouse" },
  { name: "Accountant", role: "accountant", username: "accountant", password: "accountant" },
  { name: "Viewer", role: "viewer", username: "viewer", password: "viewer" },
];

function isAllowed(role: UserRole, path: string): boolean {
  const list = ROLE_ALLOWED_PATHS[role];
  if (list.includes("*")) return true;
  return list.some(
    (p) => path === p || path.startsWith(p + "/") || (p !== "/" && path.startsWith(p)),
  );
}

for (const user of USERS) {
  test.describe(`Guard Check — ${user.name} (${user.role})`, () => {
    test.beforeEach(async ({ page }) => {
      await logout(page);
      await loginAs(page, { username: user.username, password: user.password });
    });

    const allowed = ALL_ROUTES.filter((r) => isAllowed(user.role, r));
    const blocked = ALL_ROUTES.filter((r) => !isAllowed(user.role, r));

    for (const route of allowed) {
      test(`allowed: ${route}`, async ({ page }) => {
        test.setTimeout(15000);
        const { errors } = await assertRouteOk(page, route);
        const denied = await page
          .getByText("غير مصرح بالوصول", { exact: false })
          .isVisible()
          .catch(() => false);
        expect(denied).toBe(false);
        expect(errors).toEqual([]);
      });
    }

    for (const route of blocked) {
      test(`blocked: ${route}`, async ({ page }) => {
        test.setTimeout(15000);
        const { errors } = await assertRouteOk(page, route);
        const denied = await page
          .getByText("غير مصرح بالوصول", { exact: false })
          .isVisible()
          .catch(() => false);
        expect(denied).toBe(true);
        expect(errors).toEqual([]);
      });
    }

    if (user.role === "viewer") {
      test("viewer cannot see create/edit/delete buttons on /invoices", async ({ page }) => {
        test.setTimeout(15000);
        await page.goto("/invoices", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
        const newBtn = page.getByRole("link", { name: /جديد|إضافة/i });
        await expect(newBtn).toHaveCount(0);
      });
    }
  });
}
