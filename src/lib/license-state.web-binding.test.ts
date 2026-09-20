import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/desktop-bridge", () => ({
  isTauri: () => false,
  getDesktopFingerprint: async () => {
    throw new Error("not desktop");
  },
}));

describe("getActivationDeviceInfo web non-binding (Phase 3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks browser fingerprint as non-binding with web: prefix", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "VitestBrowser",
      language: "ar",
    });
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () => new Uint8Array(32).buffer,
      },
    });
    const { getActivationDeviceInfo } = await import("@/lib/license-state");
    const info = await getActivationDeviceInfo();
    expect(info.bindingCapable).toBe(false);
    expect(info.fingerprint.startsWith("web:")).toBe(true);
  });
});
