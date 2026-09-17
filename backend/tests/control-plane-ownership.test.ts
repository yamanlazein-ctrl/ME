import { describe, expect, it } from "vitest";
import {
  isVendorOnlyAction,
  resolveDeviceLimit,
  syncedDeviceLimitFields,
  VENDOR_ONLY_ACTIONS,
  CUSTOMER_ORG_ACTIONS,
} from "../src/domain/licensing/ownership.js";

describe("Control Plane ownership — resolveDeviceLimit SoT", () => {
  it("prefers limits.devices over maxDevices column", () => {
    expect(resolveDeviceLimit({ limits: { devices: 5 }, maxDevices: 3 })).toBe(5);
  });

  it("falls back to maxDevices when limits.devices missing", () => {
    expect(resolveDeviceLimit({ limits: { users: 10 }, maxDevices: 4 })).toBe(4);
    expect(resolveDeviceLimit({ limits: null, maxDevices: 2 })).toBe(2);
  });

  it("returns 0 when neither is usable", () => {
    expect(resolveDeviceLimit({})).toBe(0);
    expect(resolveDeviceLimit({ limits: {}, maxDevices: null })).toBe(0);
  });

  it("ignores negative / non-finite values", () => {
    expect(resolveDeviceLimit({ limits: { devices: -1 }, maxDevices: 3 })).toBe(3);
    expect(resolveDeviceLimit({ limits: { devices: Number.NaN }, maxDevices: 2 })).toBe(2);
  });

  it("syncedDeviceLimitFields keeps column and JSON equal", () => {
    expect(syncedDeviceLimitFields(7)).toEqual({ maxDevices: 7, limitsDevices: 7 });
    expect(syncedDeviceLimitFields(3.9)).toEqual({ maxDevices: 3, limitsDevices: 3 });
  });
});

describe("Control Plane ownership — action planes", () => {
  it("classifies vendor-only transfer / plan / limits", () => {
    expect(isVendorOnlyAction("license.transfer")).toBe(true);
    expect(isVendorOnlyAction("license.change_limits")).toBe(true);
    expect(isVendorOnlyAction("devices.revoke_seat")).toBe(false);
    expect(VENDOR_ONLY_ACTIONS).toContain("license.suspend");
    expect(CUSTOMER_ORG_ACTIONS).toContain("devices.revoke_seat");
    expect(CUSTOMER_ORG_ACTIONS).not.toContain("license.transfer");
  });
});
