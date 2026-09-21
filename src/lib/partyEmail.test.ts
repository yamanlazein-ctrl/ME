import { describe, it, expect } from "vitest";
import { partyEmailError, INVALID_EMAIL_MESSAGE } from "./partyEmail";

describe("partyEmailError", () => {
  it("accepts blank, whitespace and valid emails (with stray spaces)", () => {
    expect(partyEmailError("")).toBeNull();
    expect(partyEmailError("   ")).toBeNull();
    expect(partyEmailError(undefined)).toBeNull();
    expect(partyEmailError("a@b.co")).toBeNull();
    expect(partyEmailError("  a@b.co ")).toBeNull();
  });
  it("rejects names/phones with a readable Arabic message", () => {
    for (const bad of ["أحمد", "0933123456", "admin", "a@b"]) {
      expect(partyEmailError(bad)).toBe(INVALID_EMAIL_MESSAGE);
    }
  });
});
