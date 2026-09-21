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

/** Money side of a document: its currency plus the FX rate frozen on it. */
export interface FxSide {
  currency: string;
  /** Units of `currency` per 1 USD — frozen at document creation. */
  exchangeRate?: number | null;
}

/**
 * Inverse of `computeBaseEquivalent`: turn a USD base amount back into
 * `currency` using that currency's frozen rate. Returns null when the target
 * currency is not USD and carries no usable rate — callers must treat null as
 * "unconvertible", never guessing a current rate.
 */
export function fromBaseEquivalent(
  baseAmount: number,
  currency: string,
  exchangeRate?: number | null,
): number | null {
  if (!Number.isFinite(baseAmount)) return null;
  if (currency === BASE_CURRENCY) return round2dp(baseAmount);
  if (!isValidFxRate(exchangeRate)) return null;
  return round2dp(baseAmount * exchangeRate);
}

/**
 * Express `amount` — recorded in one document's currency — in ANOTHER
 * document's currency, routing through the USD base currency:
 *
 *     amount  ÷ fromRate  →  USD base  ×  toRate  →  target currency
 *
 * Each side uses its OWN frozen rate, exactly as captured on its document at
 * creation time; a historical document is never re-valued at a later rate.
 *
 * The whole trip happens in ONE pass with a single rounding at the end.
 * Rounding the intermediate USD value to 2dp first and then multiplying would
 * inject an error of up to `rate / 2` — e.g. ~68 SYP at 13,500 SYP/USD — which
 * is enough to wrongly reject a payment that settles the invoice exactly.
 *
 * Same-currency amounts are returned untouched: no rate is needed to compare
 * two SYP numbers, and requiring one would break legacy rows written before
 * the FX columns existed.
 *
 * Returns null when either side is non-USD and missing its rate.
 */
export function convertAmount(amount: number, from: FxSide, to: FxSide): number | null {
  if (!Number.isFinite(amount)) return null;
  if (from.currency === to.currency) return round2dp(amount);
  const fromRate = from.currency === BASE_CURRENCY ? 1 : from.exchangeRate;
  const toRate = to.currency === BASE_CURRENCY ? 1 : to.exchangeRate;
  if (!isValidFxRate(fromRate) || !isValidFxRate(toRate)) return null;
  return round2dp((amount / fromRate) * toRate);
}

/**
 * Convert `amount` (in `fromCurrency`) into `toCurrency` for the purpose of
 * settling a NEW voucher/payment against a specific invoice/roll RIGHT NOW —
 * using the rate entered ON THIS TRANSACTION, never either side's own
 * historical frozen rate.
 *
 * This differs from `convertAmount` on purpose: `convertAmount` routes each
 * side through its OWN frozen rate, which is correct for combining two
 * already-recorded historical documents into a base-equivalent total, but
 * wrong here — it silently ignores whatever rate the user just typed
 * whenever the voucher's own currency happens to be USD (USD's "rate to
 * itself" is trivially 1, so `convertAmount` falls back to the OTHER side's
 * frozen rate instead), which both discards the manually-entered rate and
 * settles against a stale rate — a real violation of "exchange rate is
 * always manual, never assumed" for the single most common cross-currency
 * case (paying in USD against a SYP invoice).
 *
 * `enteredRate` is always "units of the non-USD side per 1 USD" (matching
 * the one exchange-rate field the voucher/print-job forms collect),
 * regardless of which side of the conversion is USD.
 */
export function convertForSettlement(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  enteredRate: number | null | undefined,
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (fromCurrency === toCurrency) return round2dp(amount);
  if (fromCurrency === BASE_CURRENCY) {
    if (!isValidFxRate(enteredRate)) return null;
    return round2dp(amount * enteredRate);
  }
  if (toCurrency === BASE_CURRENCY) {
    if (!isValidFxRate(enteredRate)) return null;
    return round2dp(amount / enteredRate);
  }
  // Neither side is USD (e.g. a EUR voucher against a SYP invoice) — one
  // manual USD-anchored rate cannot bridge two non-USD currencies.
  return null;
}

/**
 * How much of an invoice's REMAINING balance a payment settles, in the
 * invoice's currency — with exact closure.
 *
 * A payment is entered in its own currency to that currency's smallest unit
 * (0.01). Converting it into the invoice currency therefore cannot hit an
 * arbitrary remaining balance: paying the exact USD amount for a 1,000,000 SYP
 * invoice at 13,500 is 74.07 USD (the true 74.0740… cannot be typed), which
 * converts to 999,945 SYP and used to leave 55 SYP forever — or, entered as
 * 74.08, was rejected as over-payment. Neither is a real debt: it is the
 * payment currency's rounding quantum.
 *
 * Rule: when the payment equals the remaining balance restated in the payment
 * currency and rounded to that currency's smallest unit, it settles the
 * remaining balance EXACTLY (so paid == total and the balance is exactly 0).
 * Any other amount settles its plain conversion (`convertForSettlement`), so a
 * genuinely short or excessive payment is never silently rounded to "full".
 *
 * Same-currency payments reduce to the ordinary comparison. Returns null when
 * the conversion is impossible (missing rate).
 */
export function settleAmountAgainstRemaining(
  amount: number,
  paymentCurrency: string,
  invoiceCurrency: string,
  enteredRate: number | null | undefined,
  remaining: number,
): number | null {
  const plain = convertForSettlement(amount, paymentCurrency, invoiceCurrency, enteredRate);
  if (plain === null) return null;
  if (!(remaining > 0)) return plain;
  const remainingInPaymentCurrency = convertForSettlement(
    remaining,
    invoiceCurrency,
    paymentCurrency,
    enteredRate,
  );
  if (remainingInPaymentCurrency !== null && round2dp(amount) === remainingInPaymentCurrency) {
    return round2dp(remaining);
  }
  return plain;
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
