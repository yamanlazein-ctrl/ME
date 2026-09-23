import { describe, it, expect } from "vitest";
import { saneSypRateError, sypRateDeviationWarning, MIN_SANE_SYP_RATE } from "./fx.js";

describe("saneSypRateError — hard floor for a SYP-paired rate", () => {
  it("rejects a dropped-digit rate like 127", () => {
    expect(saneSypRateError("SYP", 127)).toMatch(/غير منطقي/);
  });

  it("accepts a realistic rate", () => {
    expect(saneSypRateError("SYP", 13_800)).toBeNull();
  });

  it("accepts the floor value itself", () => {
    expect(saneSypRateError("SYP", MIN_SANE_SYP_RATE)).toBeNull();
  });

  it("never applies the SYP floor to EUR (legitimately < 2)", () => {
    expect(saneSypRateError("EUR", 0.92)).toBeNull();
  });

  it("is a no-op when no rate was given", () => {
    expect(saneSypRateError("SYP", undefined)).toBeNull();
    expect(saneSypRateError("SYP", null)).toBeNull();
  });
});

describe("sypRateDeviationWarning — soft, non-blocking mismatch check", () => {
  it("warns when the entered rate is far from the reference rate", () => {
    expect(sypRateDeviationWarning("SYP", 13_800, 14_000)).toBeNull();
    expect(sypRateDeviationWarning("SYP", 9_000, 14_000)).toMatch(/يختلف بنسبة/);
  });

  it("does not warn within the default 30% band", () => {
    // 14,000 * 0.71 = 9,940 -> ~29% below reference, inside the band
    expect(sypRateDeviationWarning("SYP", 9_940, 14_000)).toBeNull();
  });

  it("never applies to EUR or when the reference rate is unavailable", () => {
    expect(sypRateDeviationWarning("EUR", 0.5, 0.9)).toBeNull();
    expect(sypRateDeviationWarning("SYP", 9_000, null)).toBeNull();
  });
});
