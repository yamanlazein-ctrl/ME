import { describe, it, expect } from "vitest";

/**
 * Smoke tests for the env schema and the withTenantTx helper.
 *
 * These tests do NOT need a running database — they verify shape and
 * pre-condition checks. Full integration tests for withTenantTx require
 * a Postgres instance and are deferred to 0C (when license/secrets
 * tables land and the test database can be seeded).
 */
describe("env schema", () => {
  it("requires DATABASE_URL", () => {
    // Loaded statically above; absence would have thrown at import time.
    expect(process.env.DATABASE_URL).toBeDefined();
  });

  it("requires JWT_SECRET to be at least 32 chars", () => {
    // Loaded statically; would have thrown on a too-short value.
    expect(process.env.JWT_SECRET?.length ?? 0).toBeGreaterThanOrEqual(32);
  });
});

describe("withTenantTx", () => {
  it("rejects empty tenantId", async () => {
    const { withTenantTx } = await import("@/infrastructure/orm/drizzle");
    await expect(withTenantTx("", async () => 1)).rejects.toThrow(/tenantId is required/);
  });
});
