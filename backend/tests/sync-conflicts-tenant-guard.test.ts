import { describe, it, expect } from "vitest";
import { assertSyncConflictTenantContext } from "../src/application/use-cases/sync/syncConflicts.js";
import { runWithTenantContext } from "../src/infrastructure/orm/tenant-context.js";

describe("DFP-019 syncConflicts tenant context guard", () => {
  it("fails closed with no ambient/ALS tenant", () => {
    expect(() => assertSyncConflictTenantContext("11111111-1111-4111-8111-111111111111")).toThrow(
      /without tenant context/,
    );
  });

  it("fails closed on mismatch", () => {
    runWithTenantContext({ tenantId: "11111111-1111-4111-8111-111111111111" }, () => {
      expect(() =>
        assertSyncConflictTenantContext("22222222-2222-4222-8222-222222222222"),
      ).toThrow(/tenant mismatch/);
    });
  });

  it("allows matching ALS tenant", () => {
    const tid = "11111111-1111-4111-8111-111111111111";
    runWithTenantContext({ tenantId: tid }, () => {
      expect(() => assertSyncConflictTenantContext(tid)).not.toThrow();
    });
  });
});
