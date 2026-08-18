import type { Page, Expect } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Sign in as the dev seed user (admin / admin) if the page is on the
 * login form. Idempotent — silently returns if already authenticated.
 *
 * The form's username/password fields are pre-filled with admin/admin
 * (see src/components/auth/AuthGate.tsx), so submitting is enough.
 *
 * For new tests that need a non-default user, prefer the
 * `loginAs(page, { username, password })` variant.
 */
export async function loginIfNeeded(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });

  const submitBtn = page.locator('button[type="submit"]');
  try {
    await submitBtn.waitFor({ state: "visible", timeout: 5_000 });
    await submitBtn.click();
  } catch {
    // already logged in
  }

  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 20_000 });
}

/**
 * Sign in as a specific user. Clears the form first, then types and submits.
 */
export async function loginAs(
  page: Page,
  creds: { username: string; password: string },
): Promise<void> {
  await page.goto("/", { waitUntil: "networkidle" });
  const usernameInput = page.locator('input[name="username"], input[type="text"]').first();
  const passwordInput = page.locator('input[type="password"]').first();
  await usernameInput.fill(creds.username);
  await passwordInput.fill(creds.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 20_000 });
}

/**
 * Clear the dev session and force the login form to appear on next navigation.
 */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      localStorage.removeItem("erp.auth.userId");
      localStorage.removeItem("erp.auth.accessToken");
    } catch {
      /* ignore */
    }
  });
}
