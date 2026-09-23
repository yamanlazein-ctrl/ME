import { describe, expect, it } from "vitest";
import { planSaleSettlement } from "./useCustomerCredit";

describe("planSaleSettlement", () => {
  it("overpayment: invoice paid, excess becomes credit, no debt", () => {
    expect(
      planSaleSettlement({ total: 10_000, cashPaid: 20_000, availableCredit: 0, useCredit: true }),
    ).toEqual({ cashApplied: 10_000, creditApplied: 0, excessCash: 10_000, debt: 0 });
  });

  it("credit covers the whole invoice", () => {
    expect(
      planSaleSettlement({ total: 12_000, cashPaid: 0, availableCredit: 15_000, useCredit: true }),
    ).toEqual({ cashApplied: 0, creditApplied: 12_000, excessCash: 0, debt: 0 });
  });

  it("insufficient credit → the shortfall is debt", () => {
    expect(
      planSaleSettlement({
        total: 8_000,
        cashPaid: 1_000,
        availableCredit: 3_000,
        useCredit: true,
      }),
    ).toEqual({ cashApplied: 1_000, creditApplied: 3_000, excessCash: 0, debt: 4_000 });
  });

  it("opting out of credit leaves it untouched", () => {
    expect(
      planSaleSettlement({ total: 8_000, cashPaid: 0, availableCredit: 3_000, useCredit: false }),
    ).toEqual({ cashApplied: 0, creditApplied: 0, excessCash: 0, debt: 8_000 });
  });
});
