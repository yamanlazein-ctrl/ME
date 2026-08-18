/**
 * Money — immutable value object with safe arithmetic.
 */
import type { Currency } from "../types/index.js";
export type { Currency };

export interface MoneyData {
  amount: number;
  currency: Currency;
}

export class Money implements MoneyData {
  readonly amount: number;
  readonly currency: Currency;

  constructor(amount: number, currency: Currency) {
    if (!Number.isFinite(amount)) throw new TypeError("Money amount must be finite");
    this.amount = amount;
    this.currency = currency;
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  static from(data: MoneyData): Money {
    return new Money(data.amount, data.currency);
  }

  private guardSame(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.guardSame(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.guardSame(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  multiply(factor: number): Money {
    return new Money(this.amount * factor, this.currency);
  }

  divide(divisor: number): Money {
    if (divisor === 0) throw new Error("Division by zero");
    return new Money(this.amount / divisor, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  isPositive(): boolean {
    return this.amount > 0;
  }

  isNegative(): boolean {
    return this.amount < 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  /** Rounds to an integer (primary currency units). */
  rounded(): Money {
    return new Money(Math.round(this.amount), this.currency);
  }

  toString(): string {
    return `${Math.round(this.amount).toLocaleString("en-US")} ${this.currency}`;
  }

  toJSON(): MoneyData {
    return { amount: this.amount, currency: this.currency };
  }

  /** Convert to minor units (integer) for database storage. */
  toMinorUnits(): number {
    // SYP has no subunits; USD/EUR stored as cents
    if (this.currency === "SYP") return Math.round(this.amount);
    return Math.round(this.amount * 100);
  }

  /** Create from minor units stored in database. */
  static fromMinorUnits(minor: number, currency: Currency): Money {
    if (currency === "SYP") return new Money(minor, currency);
    return new Money(minor / 100, currency);
  }
}
