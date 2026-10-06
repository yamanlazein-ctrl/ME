import { describe, it, expect } from "vitest";
import { withTenantTx } from "@/infrastructure/orm/drizzle";

/**
 * Smoke tests for the env schema and the withTenantTx helper.
 *
 * These tests do NOT need a running database — they verify shape and
 * pre-condition checks. Full integration tests for withTenantTx require
 * a Postgres instance and are deferred to 0C (when license/secrets
 * tables land and the test database can be seeded).
 */
describe("env schema", () => {
  it("requires the active engine's database location", () => {
    // Loaded statically above; absence would have thrown at import time.
    // PostgreSQL: DATABASE_URL. SQLite (desktop, test:sqlite): SQLITE_PATH and no DATABASE_URL.
    if (process.env.DB_ENGINE === "sqlite") {
      expect(process.env.SQLITE_PATH).toBeDefined();
      expect(process.env.DATABASE_URL).toBeUndefined();
    } else {
      expect(process.env.DATABASE_URL).toBeDefined();
    }
  });

  it("requires JWT_SECRET to be at least 32 chars", () => {
    // Loaded statically; would have thrown on a too-short value.
    expect(process.env.JWT_SECRET?.length ?? 0).toBeGreaterThanOrEqual(32);
  });
});

describe("withTenantTx", () => {
  it("rejects empty tenantId", async () => {
    await expect(withTenantTx("", async () => 1)).rejects.toThrow(/tenantId is required/);
  });
});
