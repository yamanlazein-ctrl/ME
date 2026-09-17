import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test for F08 (Phase 1 foundation audit): the "stale/hardcoded
 * company picker" bug. On a desktop-deploy build, `resolveTenantId()` used
 * to check the build-time `VITE_DEFAULT_TENANT_ID` constant BEFORE this
 * device's own recorded activation (`getInstallTenantId()`). That env var
 * is baked into the installer at build time (see .env.example) and shared
 * by every copy of the same build — so once installed on a real customer's
 * machine and activated against their real tenant, the picker would still
 * show whichever tenant happened to be baked in at build time (a dev/demo
 * tenant) instead of the one actually activated on that device.
 */

let getInstallTenantId: () => string | null;

const REAL_ACTIVATION_TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BAKED_BUILD_TIME_TENANT = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9"; // matches .env.example

vi.mock("@/lib/license-state", () => ({
  getInstallTenantId: () => getInstallTenantId(),
  setInstallTenantId: () => undefined,
  getDecryptedActivationId: async () => null,
  getServerFingerprint: async () => null,
}));

describe("resolveTenantId (F08 regression — stale company picker)", () => {
  beforeEach(() => {
    getInstallTenantId = () => null;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("desktop deploy: prefers this device's own recorded activation over the baked build-time tenant", async () => {
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "true");
    vi.stubEnv("VITE_DEFAULT_TENANT_ID", BAKED_BUILD_TIME_TENANT);
    getInstallTenantId = () => REAL_ACTIVATION_TENANT;

    const { resolveTenantId } = await import("./UserPickerPage");
    expect(resolveTenantId()).toBe(REAL_ACTIVATION_TENANT);
  });

  it("desktop deploy: falls back to the baked tenant only when this device has never activated anything", async () => {
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "true");
    vi.stubEnv("VITE_DEFAULT_TENANT_ID", BAKED_BUILD_TIME_TENANT);
    getInstallTenantId = () => null;

    const { resolveTenantId } = await import("./UserPickerPage");
    expect(resolveTenantId()).toBe(BAKED_BUILD_TIME_TENANT);
  });

  it("web deploy: prefers the recorded activation over the baked default too", async () => {
    vi.stubEnv("VITE_DESKTOP_DEPLOY", "false");
    vi.stubEnv("VITE_DEFAULT_TENANT_ID", BAKED_BUILD_TIME_TENANT);
    getInstallTenantId = () => REAL_ACTIVATION_TENANT;

    const { resolveTenantId } = await import("./UserPickerPage");
    expect(resolveTenantId()).toBe(REAL_ACTIVATION_TENANT);
  });
});
