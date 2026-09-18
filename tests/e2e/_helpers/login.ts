/**
 * Shared Playwright login using env-backed credentials (DFP-029).
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { e2eAdminAuth, e2eRoleAuth } from "./testCredentials.js";

export async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = e2eAdminAuth();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const emailInput = page.locator('input[placeholder="admin@erp.local"], input[type="email"]').first();
  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  await emailInput.fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await expect(page.locator("body")).toContainText(/لوحة التحكم|Dashboard/i, { timeout: 30_000 });
}

/** Cert-route login with username/password (env-backed via e2eRoleAuth). */
export async function loginAs(
  page: Page,
  creds: { username: string; password: string },
): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const userInput = page
    .locator('input[placeholder="admin@erp.local"], input[type="email"], input[autocomplete="username"]')
    .first();
  await userInput.waitFor({ state: "visible", timeout: 20_000 });
  await userInput.fill(creds.username);
  await page.locator('input[type="password"]').first().fill(creds.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(500);
}

export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().clearCookies();
}

export { e2eAdminAuth, e2eRoleAuth };
