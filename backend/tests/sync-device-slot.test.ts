/**
 * DESK-028: every path that adds a sync device on the hub obeys the licence device limit
 * (enrollment did; `/api/auth/sync-device` did not). One rule, `deviceSlotRefusal`, checked under the
 * per-tenant queue so two simultaneous registrations cannot both take the last seat.
 */
import { describe, it, expect } from "vitest";
import {
  deviceSlotRefusal,
  withTenantDeviceLock,
} from "@/application/use-cases/sync/syncEnrollment.js";

const T = "00000000-0000-4000-8000-0000000000aa";
type Dev = { id: string; deviceFingerprint: string; revokedAt: Date | null };

function hub(devices: Dev[], maxDevices = 1) {
  return {
    devices,
    deps: {
      syncDeviceRepo: {
        findById: async (_t: string, id: string) => devices.find((d) => d.id === id) ?? null,
        listForTenant: async () => devices,
      },
      licenseRepo: { findActiveForTenant: async () => ({ maxDevices, limits: null }) },
    } as never,
  };
}

describe("licence device slots", () => {
  it("refuses a NEW device when the licence is full, by any path", async () => {
    const h = hub([{ id: "a", deviceFingerprint: "fp-a", revokedAt: null }]);
    const r = await deviceSlotRefusal(h.deps, T, { id: "b", fingerprint: "fp-b" });
    expect(r).toMatchObject({ ok: false, status: 403, code: "DEVICE_LIMIT" });
  });

  it("a known device (same id or same live fingerprint) is a touch, never refused", async () => {
    const h = hub([{ id: "a", deviceFingerprint: "fp-a", revokedAt: null }]);
    expect(await deviceSlotRefusal(h.deps, T, { id: "a", fingerprint: "fp-a" })).toBeNull();
    expect(await deviceSlotRefusal(h.deps, T, { id: null, fingerprint: "fp-a" })).toBeNull();
  });

  it("a revoked device frees its seat", async () => {
    const h = hub([{ id: "a", deviceFingerprint: "fp-a", revokedAt: new Date() }]);
    expect(await deviceSlotRefusal(h.deps, T, { id: "b", fingerprint: "fp-b" })).toBeNull();
  });

  it("two simultaneous registrations cannot both take the last seat", async () => {
    const h = hub([], 1);
    const attempt = (id: string) =>
      withTenantDeviceLock(T, async () => {
        const refusal = await deviceSlotRefusal(h.deps, T, { id, fingerprint: `fp-${id}` });
        if (refusal) return refusal.code;
        await new Promise((r) => setTimeout(r, 20)); // the insert takes time
        h.devices.push({ id, deviceFingerprint: `fp-${id}`, revokedAt: null });
        return "registered";
      });
    const results = await Promise.all([attempt("x"), attempt("y")]);
    expect(results.sort()).toEqual(["DEVICE_LIMIT", "registered"]);
    expect(h.devices).toHaveLength(1);
  });
});
