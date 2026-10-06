/**
 * Shared Playwright login using env-backed credentials (DFP-029).
 *
 * The login screen is the PIN user picker (UserPickerPage): there is no email/password form any
 * more. The suites therefore authenticate through the real `POST /api/auth/login` (email +
 * password, same endpoint and checks as before) and hand the issued session to the page exactly
 * as the app stores it (TokenProvider keys), then open the app and wait for the dashboard.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eAdminAuth, e2eRoleAuth } from "./testCredentials.js";

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";

/** Tenant of the disposable stack (tests/e2e/cert-stack.mjs), or E2E_TENANT_ID. */
function stackTenantId(): string | undefined {
  if (process.env.E2E_TENANT_ID) return process.env.E2E_TENANT_ID;
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".cert-stack.json");
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { tenantId?: string }).tenantId;
  } catch {
    return undefined;
  }
}

async function apiLogin(page: Page, email: string, password: string): Promise<{ status: number }> {
  const tenantId = stackTenantId();
  const res = await page.request.post(`${BACKEND}/api/auth/login`, {
    data: { email, password, ...(tenantId ? { tenantId } : {}) },
  });
  if (!res.ok()) return { status: res.status() };
  const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!body.accessToken) return { status: 500 };
  await page.addInitScript(
    ([access, refresh, tenant]) => {
      localStorage.setItem("erp.auth.accessToken", access);
      if (refresh) localStorage.setItem("erp.auth.refreshToken", refresh);
      if (tenant) localStorage.setItem("erp.install.tenantId", tenant);
    },
    [body.accessToken, body.refreshToken ?? "", tenantId ?? ""] as const,
  );
  return { status: res.status() };
}

export async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = e2eAdminAuth();
  const { status } = await apiLogin(page, email, password);
  if (status >= 300) throw new Error(`admin login failed: HTTP ${status}`);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toContainText(/لوحة التحكم|Dashboard/i, { timeout: 30_000 });
}

/** Cert suites historically imported this name — alias of admin login. */
export async function loginIfNeeded(page: Page): Promise<void> {
  await loginAsAdmin(page);
}

/**
 * Cert-route login with username/password (env-backed via e2eRoleAuth). Like the old form submit,
 * it does not assert success: role specs check what the user can see afterwards.
 */
export async function loginAs(
  page: Page,
  creds: { username: string; password: string },
): Promise<void> {
  await apiLogin(page, creds.username, creds.password);
  await page.goto("/", { waitUntil: "domcontentloaded" });
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
