/**
 * Base-currency FX rules.
 *
 * BASE CURRENCY = USD. Every document recorded in another currency must
 * persist, immutably, at creation time:
 *   - transaction currency        (document column `currency`)
 *   - transaction amount          (document amount columns)
 *   - exchangeRate                (units of the document currency per 1 USD)
 *   - exchange rate date          (= the document date)
 *   - base equivalent             (`base_*` columns, USD, 2dp)
 *
 * Historical documents are NEVER re-valued at a later/current rate: once
 * written, exchangeRate and base amounts are frozen. Aggregations that need
 * a single number sum ONLY base (USD) values and must never add raw amounts
 * across different currencies.
 */

import { z } from "zod";
import { round2dp } from "./precision.js";

export const BASE_CURRENCY = "USD";

/** A valid FX rate: finite and strictly positive (units per 1 USD). */
export function isValidFxRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Convert a transaction amount into the USD base equivalent using the rate
 * captured AT the transaction date. For USD documents the rate is ignored
 * (equivalent === amount). Returns null when no rate exists — callers must
 * treat null as "unconverted" and exclude it from any cross-currency sum,
 * never guessing a current rate for a historical document.
 */
export function computeBaseEquivalent(
  amount: number,
  currency: string,
  exchangeRate?: number | null,
): number | null {
  if (currency === BASE_CURRENCY) return round2dp(amount);
  if (!isValidFxRate(exchangeRate)) return null;
  return round2dp(amount / exchangeRate);
}

export const FX_REQUIRED_MESSAGE = "سعر الصرف مطلوب لكل عملية ليست بالدولار (عملة الأساس USD)";

/** Zod fragment: optional but strictly-positive exchange rate field. */
export const exchangeRateSchema = z
  .number()
  .positive("سعر الصرف يجب أن يكون أكبر من صفر")
  .max(1_000_000_000, "سعر الصرف كبير جداً")
  .optional();

/** True when the document satisfies the FX rule (USD, or a rate is present). */
export function requireFxRate(
  currency: string | undefined,
  exchangeRate: number | undefined,
): boolean {
  const c = currency ?? BASE_CURRENCY;
  return c === BASE_CURRENCY || (typeof exchangeRate === "number" && exchangeRate > 0);
}
