import { describe, it, expect } from "vitest";
import { USD_RATE, EXCHANGE_RATES } from "@/presentation/hooks/useCurrency";

describe("USD_RATE", () => {
  it("matches EXCHANGE_RATES.USD", () => {
    expect(USD_RATE).toBe(EXCHANGE_RATES.USD);
  });

  it("is positive", () => {
    expect(USD_RATE).toBeGreaterThan(0);
  });

  it("is used consistently — computed SYP value matches manual calc", () => {
    const dollarAmount = 100;
    const expectedSyp = dollarAmount * USD_RATE;
    expect(expectedSyp).toBe(100 * EXCHANGE_RATES.USD);
  });
});
