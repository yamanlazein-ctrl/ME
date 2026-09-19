import { describe, expect, it } from "vitest";
import {
  runWithPlatformContext,
  runWithTenantContext,
  tenantContext,
} from "../src/infrastructure/orm/tenant-context.js";

describe("platform request context", () => {
  it("restores the caller context after a successful async scope", async () => {
    await runWithTenantContext({ tenantId: "tenant-a" }, async () => {
      await runWithPlatformContext(async () => {
        expect(tenantContext.getStore()).toEqual({
          tenantId: "tenant-a",
          platformMode: true,
        });
      });
      expect(tenantContext.getStore()).toEqual({ tenantId: "tenant-a" });
    });
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it("restores the caller context when the platform scope rejects", async () => {
    await runWithTenantContext({ tenantId: "tenant-a" }, async () => {
      await expect(
        runWithPlatformContext(async () => {
          throw new Error("scope failure");
        }),
      ).rejects.toThrow("scope failure");
      expect(tenantContext.getStore()).toEqual({ tenantId: "tenant-a" });
    });
  });
});
