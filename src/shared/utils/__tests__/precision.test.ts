import { describe, it, expect } from "vitest";
import { hasMoreThan2dp, round2dp, MAX_2DP_MSG } from "../precision";

describe("precision helpers (mirror of backend decimal(12,2) rule)", () => {
  it("flags more than 2 decimal places (this is what broke the user's save)", () => {
    expect(hasMoreThan2dp(2323.423)).toBe(true);
    expect(hasMoreThan2dp(32.423)).toBe(true);
    expect(hasMoreThan2dp(0.001)).toBe(true);
  });

  it("accepts integers and up to 2 decimal places", () => {
    expect(hasMoreThan2dp(2323.42)).toBe(false);
    expect(hasMoreThan2dp(32)).toBe(false);
    expect(hasMoreThan2dp(0.01)).toBe(false);
    expect(hasMoreThan2dp(100000)).toBe(false);
  });

  it("treats zero and non-finite as OK (no premature flag)", () => {
    expect(hasMoreThan2dp(0)).toBe(false);
    expect(hasMoreThan2dp(NaN)).toBe(false);
    expect(hasMoreThan2dp(Infinity)).toBe(false);
  });

  it("rounds to 2 decimal places", () => {
    expect(round2dp(2323.423)).toBe(2323.42);
    expect(round2dp(32.999)).toBe(33);
    expect(round2dp(NaN)).toBe(0);
  });

  it("exposes the same message wording as the backend", () => {
    expect(MAX_2DP_MSG).toContain("خانتين عشريتين");
  });
});