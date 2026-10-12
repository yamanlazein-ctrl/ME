import { describe, it, expect } from "vitest";
import { isLoopbackAddress, resolveDesktopLocalCaller } from "@/infrastructure/http/localAccess.js";

describe("desktop local access", () => {
  it("accepts loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("named-pipe callers have no TCP peer — still local when the sidecar is pipe-bound", () => {
    expect(resolveDesktopLocalCaller(true, undefined)).toBe(true);
    expect(resolveDesktopLocalCaller(false, undefined)).toBe(false);
    expect(resolveDesktopLocalCaller(false, "127.0.0.1")).toBe(true);
  });

  // SEC-01: a TCP-bound desktop sidecar must not treat another LAN host as "this machine" — that
  // opened the pre-auth wizard restore and the device-proof bypass to the whole office network.
  it("a LAN peer is NOT the local desktop caller on TCP", () => {
    for (const ip of ["192.168.1.20", "10.0.0.8", "172.16.4.2", "169.254.1.1", "fd00::5"]) {
      expect(resolveDesktopLocalCaller(false, ip)).toBe(false);
    }
  });
});
