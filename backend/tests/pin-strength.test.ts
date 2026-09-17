import { describe, it, expect } from "vitest";
import { isWeakPin } from "@/domain/value-objects/pinStrength";
import { SetPinSchema, PinLoginSchema } from "@/presentation/routes/auth.schema";

/**
 * Regression test for F08 (Phase 1 foundation audit): PIN "0000" (and other
 * trivially guessable PINs) was accepted with no server-side check beyond
 * "exactly 4 digits". Enforced only when a user SETS a PIN — login/
 * verification must keep accepting an already-set weak PIN so existing
 * users are never locked out, only prompted to change it going forward.
 */
describe("isWeakPin", () => {
  it("rejects all-same-digit PINs", () => {
    expect(isWeakPin("0000")).toBe(true);
    expect(isWeakPin("1111")).toBe(true);
    expect(isWeakPin("9999")).toBe(true);
  });

  it("rejects ascending and descending sequences", () => {
    expect(isWeakPin("1234")).toBe(true);
    expect(isWeakPin("0123")).toBe(true);
    expect(isWeakPin("9876")).toBe(true);
    expect(isWeakPin("4321")).toBe(true);
  });

  it("accepts a non-trivial PIN", () => {
    expect(isWeakPin("7392")).toBe(false);
    expect(isWeakPin("0817")).toBe(false);
  });
});

describe("SetPinSchema (F08 regression)", () => {
  it("rejects 0000 when a user sets a new PIN", () => {
    const r = SetPinSchema.safeParse({
      userId: "11111111-1111-1111-1111-111111111111",
      pin: "0000",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a sequential PIN like 1234", () => {
    const r = SetPinSchema.safeParse({
      userId: "11111111-1111-1111-1111-111111111111",
      pin: "1234",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a non-trivial 4-digit PIN", () => {
    const r = SetPinSchema.safeParse({
      userId: "11111111-1111-1111-1111-111111111111",
      pin: "7392",
    });
    expect(r.success).toBe(true);
  });
});

describe("PinLoginSchema (must NOT block login with an already-set weak PIN)", () => {
  it("still accepts 0000 at login — weak-PIN rejection only applies when SETTING a PIN", () => {
    const r = PinLoginSchema.safeParse({
      userId: "11111111-1111-1111-1111-111111111111",
      pin: "0000",
    });
    expect(r.success).toBe(true);
  });
});
