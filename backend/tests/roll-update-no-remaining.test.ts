import { describe, it, expect } from "vitest";
import { updateRollSchema } from "../src/presentation/routes/roll.schema.js";

describe("updateRollSchema stock integrity", () => {
  it("rejects remainingKg on update", () => {
    const parsed = updateRollSchema.safeParse({
      rollNo: "R-1",
      remainingKg: 77.5,
      pricePerKg: 10,
      initialKg: 100,
      entryDate: "2026-01-01",
    });
    expect(parsed.success).toBe(false);
  });

  it("allows metadata-only update without remainingKg", () => {
    const parsed = updateRollSchema.safeParse({
      rollNo: "R-1",
      pricePerKg: 12.5,
      dyeBatch: "B1",
    });
    expect(parsed.success).toBe(true);
  });
});
