import { describe, expect, it } from "vitest";
import { canConfirmFactoryReset, FACTORY_RESET_PHRASE } from "./FactoryResetCard";

describe("factory reset needs the typed phrase", () => {
  it("rejects empty / partial / other text", () => {
    expect(canConfirmFactoryReset("")).toBe(false);
    expect(canConfirmFactoryReset("احذف")).toBe(false);
    expect(canConfirmFactoryReset("نعم")).toBe(false);
  });
  it("accepts only the exact phrase", () => {
    expect(canConfirmFactoryReset(FACTORY_RESET_PHRASE)).toBe(true);
    expect(canConfirmFactoryReset(` ${FACTORY_RESET_PHRASE} `)).toBe(true);
  });
});
