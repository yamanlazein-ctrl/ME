import { describe, expect, it, vi } from "vitest";
import {
  authenticateWithBiometrics,
  coverVisible,
  LOCK_AFTER_MS,
  shouldLock,
} from "../../src/core/appLock";

const T0 = Date.parse("2026-03-01T10:00:00Z");
const last = new Date(T0).toISOString();

describe("app lock (FR-04, FR-41)", () => {
  it("does not lock after 59 s, locks at 60 s (fake timers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 59_000);
    const base = { enabled: true, lastForegroundAt: last, coldStart: false };
    expect(shouldLock({ ...base, now: Date.now() })).toBe(false);
    vi.setSystemTime(T0 + LOCK_AFTER_MS);
    expect(shouldLock({ ...base, now: Date.now() })).toBe(true);
    vi.useRealTimers();
  });

  it("always locks on a cold start, never when disabled", () => {
    expect(shouldLock({ enabled: true, lastForegroundAt: last, now: T0, coldStart: true })).toBe(
      true,
    );
    expect(shouldLock({ enabled: false, lastForegroundAt: null, now: T0, coldStart: true })).toBe(
      false,
    );
    expect(shouldLock({ enabled: true, lastForegroundAt: null, now: T0, coldStart: false })).toBe(
      true,
    );
  });

  it("covers the content whenever the app is not active", () => {
    expect(coverVisible("active", false)).toBe(false);
    expect(coverVisible("inactive", false)).toBe(true);
    expect(coverVisible("background", false)).toBe(true);
    expect(coverVisible("active", true)).toBe(true);
  });

  it("falls back to the PIN when biometrics are missing or fail", async () => {
    const api = (hardware: boolean, enrolled: boolean, success: boolean) => ({
      hasHardwareAsync: async () => hardware,
      isEnrolledAsync: async () => enrolled,
      authenticateAsync: async () => ({ success }),
    });
    expect(await authenticateWithBiometrics(api(true, true, true))).toBe(true);
    expect(await authenticateWithBiometrics(api(true, true, false))).toBe(false);
    expect(await authenticateWithBiometrics(api(false, true, true))).toBe(false);
    expect(await authenticateWithBiometrics(api(true, false, true))).toBe(false);
  });
});
