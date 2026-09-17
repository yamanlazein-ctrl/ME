import { describe, expect, it } from "vitest";
import {
  composeDeviceFingerprint,
  fingerprintsMatch,
  parseDeviceFingerprint,
} from "../src/domain/licensing/installationIdentity.js";

describe("installationIdentity", () => {
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

  it("matches bare hash to composed fingerprint", () => {
    expect(fingerprintsMatch("host", "host::inst")).toBe(true);
    expect(fingerprintsMatch("host::inst", "host::inst")).toBe(true);
    expect(fingerprintsMatch("a::x", "b::y")).toBe(false);
  });
});
