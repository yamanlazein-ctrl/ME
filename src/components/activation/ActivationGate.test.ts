import { describe, it, expect } from "vitest";
import { shouldTrustLocalActivation } from "./ActivationGate";

/**
 * 2026-09-22 hardening regression: a reused device (stale local activation
 * markers from a PREVIOUS, now-deleted install) must never ride on a
 * coincidentally-`isCompleted: true` status from an unrelated, freshly
 * re-provisioned tenant — reproduced this session as the "FirstRun Admin"
 * locked-PIN screen on a leftover dev-machine database.
 */
describe("shouldTrustLocalActivation", () => {
  it("trusts local activation when the tenant id matches and setup is completed", () => {
    expect(shouldTrustLocalActivation({ isCompleted: true, tenantId: "t1" }, "t1")).toBe(true);
  });

  it("does not trust local activation when isCompleted is explicitly false", () => {
    expect(shouldTrustLocalActivation({ isCompleted: false, tenantId: "t1" }, "t1")).toBe(false);
  });

  it("does not trust local activation on a tenant id mismatch even when isCompleted is true", () => {
    expect(shouldTrustLocalActivation({ isCompleted: true, tenantId: "new-tenant" }, "old-tenant")).toBe(
      false,
    );
  });

  it("trusts local activation when either side has no tenant id to compare (legacy installs)", () => {
    expect(shouldTrustLocalActivation({ isCompleted: true }, "old-tenant")).toBe(true);
    expect(shouldTrustLocalActivation({ isCompleted: true, tenantId: "t1" }, null)).toBe(true);
  });

  it("trusts local activation when isCompleted is simply absent (not explicitly false)", () => {
    expect(shouldTrustLocalActivation({ tenantId: "t1" }, "t1")).toBe(true);
  });
});
