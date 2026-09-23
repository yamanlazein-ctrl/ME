import { describe, expect, it } from "vitest";
import {
  settlementFromCashAndDiscount,
  splitCashAndDiscountAcrossLines,
} from "./settlementAmounts.js";

describe("settlementFromCashAndDiscount", () => {
  it("130 cash + 6 discount closes 136 without reducing cash", () => {
    const s = settlementFromCashAndDiscount(130, 6);
    expect(s.cash).toBe(130);
    expect(s.discount).toBe(6);
    expect(s.partySettlement).toBe(136);
  });

  it("1000 cash + 10 discount settles 1010 — never 1000 − 10 = 990", () => {
    const s = settlementFromCashAndDiscount(1000, 10);
    expect(s.cash).toBe(1000);
    expect(s.discount).toBe(10);
    expect(s.partySettlement).toBe(1010);
    expect(s.cash).not.toBe(990);
  });

  it("allows a pure discount (cash = 0) to close a small remainder", () => {
    const s = settlementFromCashAndDiscount(0, 6);
    expect(s.cash).toBe(0);
    expect(s.discount).toBe(6);
    expect(s.partySettlement).toBe(6);
  });

  it("rejects empty settlement", () => {
    expect(() => settlementFromCashAndDiscount(0, 0)).toThrow(/أكبر من صفر/);
  });
});

describe("splitCashAndDiscountAcrossLines", () => {
  it("puts leftover discount on the last allocated invoice", () => {
    const parts = splitCashAndDiscountAcrossLines([100, 36], 130);
    expect(parts).toEqual([
      { cash: 100, discount: 0 },
      { cash: 30, discount: 6 },
    ]);
    expect(parts.reduce((s, p) => s + p.cash + p.discount, 0)).toBe(136);
  });
});
