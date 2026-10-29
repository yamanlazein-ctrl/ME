import { describe, expect, it } from "vitest";
import { claimLossMessage } from "../../src/core/claimLoss";

describe("claim loss alert (FR-34)", () => {
  it("names the invoice number and the roll", () => {
    const message = claimLossMessage("INV-2026-0042", ["R-17"]);
    expect(message).toContain("INV-2026-0042");
    expect(message).toContain("R-17");
    expect(message).toContain("يجب الحل من الديسكتوب");
  });
  it("lists several rolls", () => {
    expect(claimLossMessage("INV-1", ["R-1", "R-2"])).toContain("R-1، R-2");
  });
});
