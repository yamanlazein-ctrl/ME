import { describe, it, expect } from "vitest";
import {
  isLoopbackAddress,
  isLocalOrPrivateLan,
  resolveDesktopLocalCaller,
} from "@/infrastructure/http/localAccess.js";

describe("desktop local access", () => {
  it("accepts loopback and private LAN", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLocalOrPrivateLan("192.168.1.20")).toBe(true);
    expect(isLocalOrPrivateLan("10.0.0.8")).toBe(true);
    expect(isLocalOrPrivateLan("8.8.8.8")).toBe(false);
    expect(isLocalOrPrivateLan(undefined)).toBe(false);
  });

  it("named-pipe callers have no TCP peer — still local when the sidecar is pipe-bound", () => {
    expect(resolveDesktopLocalCaller(true, undefined)).toBe(true);
    expect(resolveDesktopLocalCaller(false, undefined)).toBe(false);
    expect(resolveDesktopLocalCaller(false, "127.0.0.1")).toBe(true);
  });
});
