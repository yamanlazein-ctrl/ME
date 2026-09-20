import { describe, expect, it } from "vitest";
import {
  composeDeviceFingerprint,
  fingerprintsMatch,
  isBindingFingerprint,
  parseDeviceFingerprint,
} from "../src/domain/licensing/installationIdentity.js";

describe("installationIdentity (Phase 3)", () => {
  it("composes hostHash::installationId", () => {
    expect(composeDeviceFingerprint("abc123", "11111111-1111-1111-1111-111111111111")).toBe(
      "abc123::11111111-1111-1111-1111-111111111111",
    );
  });

  it("does not double-compose an already composed hash", () => {
    const full = "abc::install-1";
    expect(composeDeviceFingerprint(full, "ignored")).toBe(full);
  });

  it("parses composed fingerprints", () => {
    expect(parseDeviceFingerprint("host::inst-9")).toEqual({
      hostHash: "host",
      installationId: "inst-9",
    });
    expect(parseDeviceFingerprint("bare")).toEqual({ hostHash: "bare", installationId: null });
  });

  it("requires both host hash and installation id for seat matching", () => {
    expect(fingerprintsMatch("host", "host::inst")).toBe(false);
    expect(fingerprintsMatch("host::inst", "host::inst")).toBe(true);
    expect(fingerprintsMatch("host::other", "host::inst")).toBe(false);
    expect(fingerprintsMatch("a::x", "b::y")).toBe(false);
  });

  it("rejects a cloned install (same install-id, different host-hash)", () => {
    const original = composeDeviceFingerprint("host-a", "install-shared");
    const clone = composeDeviceFingerprint("host-b", "install-shared");
    expect(fingerprintsMatch(original, clone)).toBe(false);
    expect(isBindingFingerprint(original)).toBe(true);
    expect(isBindingFingerprint("web:deadbeef")).toBe(false);
    expect(isBindingFingerprint("bare-sha-only")).toBe(false);
  });
});
