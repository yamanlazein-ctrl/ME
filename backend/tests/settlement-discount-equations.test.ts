/**
 * Shared settlement contract: cash + discount = party reduction;
 * cashbox moves by cash only; invoice historical totals are never mutated.
 */
import { describe, it, expect } from "vitest";
import {
  settlementFromCashAndDiscount,
  splitCashAndDiscountAcrossLines,
} from "@erp/shared";

describe("discount settlement equations (issues 3 + 7)", () => {
  it("130 cash + 6 discount closes 136 — cashbox stays 130", () => {
    const s = settlementFromCashAndDiscount(130, 6);
    expect(s.cash).toBe(130);
    expect(s.discount).toBe(6);
    expect(s.partySettlement).toBe(136);
    expect(s.cash).not.toBe(130 - 6);
  });

  it("1000 cash + 10 discount settles 1010 — never 1000 − 10 = 990", () => {
    const s = settlementFromCashAndDiscount(1000, 10);
    expect(s.cash).toBe(1000);
    expect(s.discount).toBe(10);
    expect(s.partySettlement).toBe(1010);
    expect(s.cash + s.discount).toBe(s.partySettlement);
  });

  it("supplier payment uses the same cash + discount-received equation", () => {
    const s = settlementFromCashAndDiscount(110, 5);
    expect(s.cash).toBe(110); // actual cash outflow
    expect(s.partySettlement).toBe(115); // AP reduction
  });

  it("FIFO split never subtracts discount from cash lines", () => {
    const parts = splitCashAndDiscountAcrossLines([100, 36], 130);
    expect(parts).toEqual([
      { cash: 100, discount: 0 },
      { cash: 30, discount: 6 },
    ]);
    expect(parts.reduce((n, p) => n + p.cash, 0)).toBe(130);
    expect(parts.reduce((n, p) => n + p.discount, 0)).toBe(6);
  });
});
