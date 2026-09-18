import { test, expect } from "@playwright/test";
import { loginAs, logout, e2eRoleAuth } from "../_helpers/login";
import { assertRouteOk } from "../_helpers/test-helpers";

type UserRole = "admin" | "accountant" | "warehouse" | "viewer";

type UserDef = {
  role: UserRole;
  username: string;
  password: string;
  label: string;
  allowed: string[];
  blocked: string[];
};

function roleCreds(role: UserRole): { username: string; password: string } {
  return e2eRoleAuth(role);
}

const ADMIN: UserDef = {
  role: "admin",
  ...roleCreds("admin"),
  label: "Admin",
  allowed: [
    "/",
    "/cashbox",
    "/expenses",
    "/expenses/new",
    "/inventory",
    "/invoices",
    "/invoices/entry/new",
    "/invoices/sale/new",
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
    "/ledger",
    "/print-center",
    "/settings",
    "/settings/users",
    "/settings/company",
    "/settings/activity",
    "/settings/audit",
    "/settings/backup",
    "/settings/currencies",
    "/settings/payment-methods",
    "/settings/printing",
    "/settings/taxes",
    "/settings/units",
    "/settings/warehouses",
  ],
  blocked: [],
};

const WAREHOUSE: UserDef = {
  role: "warehouse",
  ...roleCreds("warehouse"),
  label: "Warehouse",
  allowed: ["/", "/inventory", "/invoices/entry/new", "/returns/entry/new", "/print-center"],
  blocked: ["/settings", "/settings/users", "/reports", "/expenses/new"],
};

const ACCOUNTANT: UserDef = {
  role: "accountant",
  ...roleCreds("accountant"),
  label: "Accountant",
  allowed: [
    "/",
    "/invoices",
    "/invoices/entry/new",
    "/invoices/sale/new",
    "/returns",
    "/returns/entry/new",
    "/returns/sale/new",
    "/orders",
    "/orders/new",
    "/receipts",
    "/receipts/new",
    "/payments",
    "/payments/new",
    "/expenses",
    "/expenses/new",
    "/ledger",
    "/cashbox",
    "/reports",
    "/print-center",
    "/customers",
    "/suppliers",
  ],
  blocked: ["/settings", "/settings/users"],
};

const VIEWER: UserDef = {
  role: "viewer",
  ...roleCreds("viewer"),
  label: "Viewer",
  allowed: ["/", "/inventory", "/customers", "/suppliers", "/reports"],
  blocked: ["/expenses/new", "/invoices/entry/new", "/orders/new", "/settings"],
};

for (const user of [ADMIN, ACCOUNTANT, WAREHOUSE, VIEWER]) {
  test.describe(`Cert Permission — ${user.label} (${user.role})`, () => {
    test.beforeEach(async ({ page }) => {
      await logout(page);
      await loginAs(page, { username: user.username, password: user.password });
    });

    for (const route of user.allowed) {
      test(`allowed: ${route}`, async ({ page }) => {
        test.setTimeout(20000);
        const { errors } = await assertRouteOk(page, route);
        const denied = await page
          .getByText("غير مصرح بالوصول", { exact: false })
          .isVisible()
          .catch(() => false);
        expect(denied).toBe(false);
        expect(errors).toEqual([]);
      });
    }

    for (const route of user.blocked) {
      test(`blocked: ${route}`, async ({ page }) => {
        test.setTimeout(20000);
        const { errors } = await assertRouteOk(page, route);
        const denied = await page
          .getByText("غير مصرح بالوصول", { exact: false })
          .isVisible()
          .catch(() => false);
        expect(denied).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  });
}
