/**
 * Security audit S1: replacing an EXISTING PIN used to need only "device proof", and any live session of the tenant
 * counted — so a viewer could set an admin's PIN and sign in as the admin.
 */
import { describe, expect, it } from "vitest";
import {
  mayReplaceExistingPin,
  type PinResetDeps,
} from "../src/presentation/routes/pinResetPolicy.js";

const admin = { id: "admin-1", pinHash: "h:1357", passwordHash: "h:secret-pass" };

function deps(over: Partial<PinResetDeps> = {}): PinResetDeps {
  return {
    sessionCaller: async () => null,
    verifySecret: async (hash, secret) => hash === `h:${secret}`,
    isLocalDesktopOperator: () => false,
    ...over,
  };
}

describe("set-pin: who may replace an existing PIN", () => {
  it("refuses a viewer's live session targeting another user (the attack)", async () => {
    const d = deps({
      sessionCaller: async () => ({ userId: "viewer-1", role: "viewer", active: true }),
    });
    expect(await mayReplaceExistingPin(admin, undefined, d)).toBe(false);
  });

  it("refuses no session, a wrong current secret, and an inactive admin", async () => {
    expect(await mayReplaceExistingPin(admin, undefined, deps())).toBe(false);
    expect(await mayReplaceExistingPin(admin, "0000", deps())).toBe(false);
    const inactive = deps({
      sessionCaller: async () => ({ userId: "a2", role: "admin", active: false }),
    });
    expect(await mayReplaceExistingPin(admin, undefined, inactive)).toBe(false);
  });

  it("allows the user's own session, an active admin, the current PIN or password, the desktop operator", async () => {
    const own = deps({
      sessionCaller: async () => ({ userId: "admin-1", role: "viewer", active: true }),
    });
    expect(await mayReplaceExistingPin(admin, undefined, own)).toBe(true);
    const otherAdmin = deps({
      sessionCaller: async () => ({ userId: "a2", role: "admin", active: true }),
    });
    expect(await mayReplaceExistingPin(admin, undefined, otherAdmin)).toBe(true);
    expect(await mayReplaceExistingPin(admin, "1357", deps())).toBe(true);
    expect(await mayReplaceExistingPin(admin, "secret-pass", deps())).toBe(true);
    expect(
      await mayReplaceExistingPin(admin, undefined, deps({ isLocalDesktopOperator: () => true })),
    ).toBe(true);
  });

  it("a failing token check or hasher counts as no proof (fails closed)", async () => {
    const broken = deps({
      sessionCaller: async () => {
        throw new Error("bad token");
      },
      verifySecret: async () => {
        throw new Error("hasher down");
      },
    });
    expect(await mayReplaceExistingPin(admin, "1357", broken)).toBe(false);
  });
});
