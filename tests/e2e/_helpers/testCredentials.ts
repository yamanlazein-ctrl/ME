/**
 * DFP-029 — single source for E2E / integration test identity.
 *
 * Never hardcode reusable passwords in specs. Set:
 *   E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, DATABASE_URL / TEST_DB_URL
 * CI and local `.env.test` must supply them. Defaults exist only when
 * NODE_ENV=test or ALLOW_TEST_SEED=1 so production boots cannot rely on them.
 */

function allowTestDefaults(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.ALLOW_TEST_SEED === "1" ||
    process.env.VITEST === "true" ||
    process.env.PLAYWRIGHT === "1"
  );
}

export function requireTestMode(context: string): void {
  if (!allowTestDefaults()) {
    throw new Error(
      `${context}: refusing embedded test credentials outside NODE_ENV=test / ALLOW_TEST_SEED=1 / Playwright`,
    );
  }
}

/** Admin login used by Playwright / API harnesses. */
export function e2eAdminAuth(): { email: string; password: string } {
  requireTestMode("e2eAdminAuth");
  const email = process.env.E2E_ADMIN_EMAIL ?? "admin@erp.local";
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "E2E_ADMIN_PASSWORD is required (set in env / .env.test). Refusing hardcoded passwords (DFP-029).",
    );
  }
  return { email, password };
}

/** Optional soft auth for specs that previously used a fixed password — still requires env. */
export function e2eAdminPasswordOrThrow(): string {
  return e2eAdminAuth().password;
}

/**
 * Role fixture passwords for cert-route suites.
 * Prefer E2E_<ROLE>_PASSWORD; admin falls back to E2E_ADMIN_PASSWORD.
 */
export function e2eRoleAuth(
  role: "admin" | "warehouse" | "accountant" | "viewer",
): { username: string; password: string } {
  requireTestMode("e2eRoleAuth");
  const envKey = `E2E_${role.toUpperCase()}_PASSWORD`;
  const password =
    process.env[envKey] ??
    (role === "admin" ? process.env.E2E_ADMIN_PASSWORD : undefined);
  if (!password) {
    throw new Error(
      `${envKey} is required for cert-route role fixtures (DFP-029). Admin may use E2E_ADMIN_PASSWORD.`,
    );
  }
  const username =
    process.env[`E2E_${role.toUpperCase()}_USER`] ??
    (role === "admin" ? (process.env.E2E_ADMIN_EMAIL ?? "admin") : role);
  return { username, password };
}

export function testDatabaseUrl(fallbackDb = "erp_test"): string {
  requireTestMode("testDatabaseUrl");
  return (
    process.env.TEST_DB_URL ??
    process.env.DATABASE_URL ??
    (() => {
      throw new Error(`TEST_DB_URL or DATABASE_URL is required; refusing implicit database credentials (requested ${fallbackDb})`);
    })()
  );
}
