/**
 * Decimal places used throughout the application.
 *
 * Money: 0 decimal places (SYP and integer-scaled currencies).
 * Weight (kg): 2 decimal places (operations may produce fractional kg).
 * Discount percent: 4 decimal places (to avoid losing precision on small amounts).
 * Tax rate: 4 decimal places.
 * USD exchange rate: never rounded — transmitted as-is from settings.
 */

export const MONEY_DECIMALS = 0;
export const WEIGHT_DECIMALS = 2;
export const DISCOUNT_DECIMALS = 4;
export const TAX_DECIMALS = 4;

export function roundMoney(value: number): number {
  return Math.round(value);
}

export function roundWeight(value: number): number {
  const factor = 10 ** WEIGHT_DECIMALS;
  return Math.round(value * factor) / factor;
}

export function roundDiscount(value: number): number {
  const factor = 10 ** DISCOUNT_DECIMALS;
  return Math.round(value * factor) / factor;
}

export function roundTax(value: number): number {
  const factor = 10 ** TAX_DECIMALS;
  return Math.round(value * factor) / factor;
}
