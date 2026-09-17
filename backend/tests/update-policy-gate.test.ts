import { describe, expect, it } from "vitest";
import {
  compareSemver,
  evaluateUpdateEligibility,
  normalizeUpdatePolicy,
} from "../src/domain/licensing/updatePolicyGate.js";

describe("compareSemver", () => {
  it("orders dotted versions", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("evaluateUpdateEligibility", () => {
  it("blocks when allow_updates is false", () => {
    const r = evaluateUpdateEligibility("1.2.0", {
      channel: "stable",
      allow_updates: false,
      minimum_version: "1.0.0",
    });
    expect(r.mayCheckForUpdates).toBe(false);
    expect(r.updatesAllowed).toBe(false);
  });

  it("forces upgrade when below minimum even if updates allowed", () => {
    const r = evaluateUpdateEligibility("0.9.0", {
      channel: "stable",
      allow_updates: true,
      minimum_version: "1.0.0",
    });
    expect(r.belowMinimum).toBe(true);
    expect(r.forceUpgrade).toBe(true);
    expect(r.mayCheckForUpdates).toBe(true);
  });

  it("rejects mismatched channel preference", () => {
    const r = evaluateUpdateEligibility("1.0.0", {
      channel: "stable",
      allow_updates: true,
      minimum_version: "1.0.0",
    }, "beta");
    expect(r.mayCheckForUpdates).toBe(false);
  });

  it("normalizes empty policy", () => {
    expect(normalizeUpdatePolicy(null).channel).toBe("stable");
  });
});
