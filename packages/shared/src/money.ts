/**
 * Shared money helpers — integer minor units (bigint) per docs/money-representation.md
 * SYP has no subunits in practice, USD/EUR have 2 decimals but stored as bigint
 * whole units scaled by 100? For now whole SYP units, validated via is2dp.
 */

export type Currency = "SYP" | "USD" | "EUR";

export type MoneyData = { amount: number; currency: Currency };

export function toMinorUnits(amount: number, currency: Currency): bigint {
  // SYP: whole units; others: 2dp → minor units (cents)
  if (currency === "SYP") return BigInt(Math.round(amount));
  return BigInt(Math.round(amount * 100));
}

export function fromMinorUnits(minor: bigint, currency: Currency): number {
  if (currency === "SYP") return Number(minor);
  return Number(minor) / 100;
}

export function guardSame(a: MoneyData, b: MoneyData): void {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: MoneyData, b: MoneyData): MoneyData {
  guardSame(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}
export function subtract(a: MoneyData, b: MoneyData): MoneyData {
  guardSame(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}
export function multiply(m: MoneyData, factor: number): MoneyData {
  return { amount: Math.round(m.amount * factor), currency: m.currency };
}
export function divide(m: MoneyData, divisor: number): MoneyData {
  if (divisor === 0) throw new Error("Division by zero");
  return { amount: Math.round(m.amount / divisor), currency: m.currency };
}
