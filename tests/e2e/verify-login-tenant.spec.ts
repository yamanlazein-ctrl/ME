import { test, expect } from "@playwright/test";
import { e2eAdminAuth } from "./_helpers/testCredentials.js";
const __e2eAdmin = e2eAdminAuth();

const BASE = "http://localhost:5173";
const API = "http://localhost:8080/api";
const TENANT = process.env.ERP_TENANT_ID;
if (!TENANT) throw new Error("ERP_TENANT_ID is required for tenant login coverage");

const PAGES = [
  { name: "entry", path: "/invoices/entry/new", colorBtn: true },
  { name: "sale", path: "/invoices/sale/new", colorBtn: true },
  { name: "print-send", path: "/invoices/print-send/new", colorBtn: false },
  { name: "print-receive", path: "/invoices/print-receive/new", colorBtn: false },
  { name: "returns-entry", path: "/returns/entry/new", colorBtn: true },
  { name: "returns-sale", path: "/returns/sale/new", colorBtn: true },
  { name: "invoices-index", path: "/invoices", colorBtn: false },
  { name: "inventory", path: "/inventory", colorBtn: false },
  { name: "customers", path: "/customers", colorBtn: false },
  { name: "reports", path: "/reports", colorBtn: false },
  { name: "statement", path: "/customers", colorBtn: false },
];

test.describe("login + page load (tenantId fix)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium only");

  test("logs in and loads every invoice page without redirect to /login", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });

    // Fill the login form
    await page.fill('input[autocomplete="username"]', __e2eAdmin.email);
    await page.fill('input[type="password"]', __e2eAdmin.password);
    await page.click('button[type="submit"]');

    // Wait to land somewhere other than /login
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
    const afterLogin = page.url();
    console.log("AFTER LOGIN URL:", afterLogin);
    expect(afterLogin).not.toContain("/login");

    for (const p of PAGES) {
      await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(500);
      const url = page.url();
      const redirected = url.includes("/login");
      console.log(`${p.name}: ${p.path} → ${url}  redirected=${redirected}`);
      expect(redirected, `${p.name} should NOT redirect to /login`).toBe(false);
    }
  });
});
