/**
 * L-5 live verification (render-level).
 *
 * Renders the REAL ActivationScreen component through Vite's transform
 * pipeline with `import.meta.env.VITE_DESKTOP_DEPLOY` toggled, and asserts
 * the license-key input is hidden in desktop pre-baked mode and visible in
 * normal mode. This executes the actual component code (not a reimplementation).
 *
 * NOTE: a full click-through in a real browser is still exercised by the
 * operator's manual EXE test; this guard protects the conditional against
 * regressions.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/license-state", () => ({
  setActivationId: () => {},
  setLicenseKey: () => {},
  setInstallTenantId: () => {},
  getInstallTenantId: () => null,
  getServerFingerprint: async () => "test-fp",
  getActivationDeviceInfo: async () => ({
    fingerprint: "web:test",
    platform: "web",
    hostname: "test",
    bindingCapable: false,
  }),
}));

vi.mock("@/lib/invitations", () => ({
  validateInvitation: async () => ({ valid: false }),
  consumeInvitation: async () => ({}),
}));

describe("L-5 ActivationScreen desktop pre-baked license key field", () => {
  it("hides the license key input when VITE_DESKTOP_DEPLOY=true", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "true");
    const { ActivationScreen } = await import("./ActivationScreen");
    const html = renderToString(React.createElement(ActivationScreen, { onActivated: () => {} }));
    expect(html).not.toContain("LIC-XXXX-XXXX-XXXX");
    expect(html).not.toContain("مفتاح الترخيص");
    expect(html).toContain("متابعة");
    expect(html).toContain("ترخيصاً مفعّلاً مسبقاً");
  });

  it("shows the license key input in normal mode when VITE_DESKTOP_DEPLOY=false", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "false");
    const { ActivationScreen } = await import("./ActivationScreen");
    const html = renderToString(React.createElement(ActivationScreen, { onActivated: () => {} }));
    expect(html).toContain("LIC-XXXX-XXXX-XXXX");
    expect(html).toContain("مفتاح الترخيص");
    expect(html).toContain("رمز دعوة");
    expect(html).not.toContain("ترخيصاً مفعّلاً مسبقاً");
  });
});
