import { useSyncExternalStore } from "react";
import type { Currency } from "@/domain/types";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


/**
 * Presentation-layer currency utilities.
 *
 * Replaces `@/lib/mock-currency` — provides the same API surface (Currency type,
 * CURRENCIES, currencySymbol, formatAmount, useCurrencies) but lives in the
 * presentation layer and has zero dependency on mock data files.
 *
 * The currency metadata is static configuration (not domain state), so it is
 * safe to define here as constants.
 */

export type { Currency };

export const CURRENCIES: { code: Currency; label: string; symbol: string }[] = [
  { code: "SYP", label: "ليرة سورية", symbol: "ل.س" },
  { code: "USD", label: "دولار أمريكي", symbol: "$" },
  { code: "EUR", label: "يورو", symbol: "€" },
];

/** Default currency used throughout the app. */
export const DEFAULT_CURRENCY: Currency = "SYP";

/** Default exchange rates relative to SYP (1 SYP = rate) — fallback until the user sets real rates in Settings. */
export const EXCHANGE_RATES: Record<Currency, number> = {
  SYP: 1,
  USD: 13500,
  EUR: 14700,
};

export const USD_RATE = EXCHANGE_RATES.USD;

export const currencyState: {
  defaultCurrency: Currency;
  rates: Record<Currency, number>;
  lastUpdated: string;
} = {
  defaultCurrency: DEFAULT_CURRENCY,
  rates: { ...EXCHANGE_RATES },
  lastUpdated: "2026-07-01",
};

/**
 * Set a manual exchange rate (SYP per 1 unit of `code`), as entered by the
 * user in Settings. Persisted via the settings API; notifies all subscribers
 * so dashboards, prices and reports re-render with the new rate immediately.
 */
export function setExchangeRate(code: Currency, rate: number): void {
  currencyState.rates[code] = rate;
  currencyState.lastUpdated = new Date().toISOString().slice(0, 10);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("currency-change"));
  }
}

export function currencySymbol(c: Currency | ""): string {
  return CURRENCIES.find((x) => x.code === c)?.symbol ?? c;
}

export function formatAmount(n: number, c: Currency): string {
  const sym = currencySymbol(c);
  return `${formatMoney(n)} ${sym}`;
}

/**
 * Fix BUG-06 / C-9 / C-10 (forensic audit 2026-08-15): the reports pages
 * used to convert every non-SYP amount via a hardcoded EXCHANGE_RATES
 * guess (`toSYP`) and sum the result into one blended number labelled
 * "SYP" — silently combining SYP, USD, and EUR totals with no real FX
 * data. This renders a per-currency breakdown as plain text instead
 * (e.g. "500,000 ل.س + 200 $") — every currency present is shown with
 * its own real amount, never converted or summed with another currency.
 * Currencies with a zero amount are omitted; if everything is zero,
 * falls back to formatAmount(0, "SYP") so callers always get a string.
 */
export function formatCurrencyBreakdown(byCurrency: Partial<Record<Currency, number>>): string {
  const parts = CURRENCIES.map((c) => byCurrency[c.code] ?? 0)
    .map((amount, i) => ({ amount, code: CURRENCIES[i].code }))
    .filter((x) => x.amount !== 0)
    .map((x) => formatAmount(x.amount, x.code));
  return parts.length > 0 ? parts.join(" + ") : formatAmount(0, "SYP");
}

/** Group an array of {amount, currency} into a Record<Currency, number> — never sums across currencies. */
export function groupAmountsByCurrency<T>(
  items: T[],
  amountOf: (item: T) => number,
  currencyOf: (item: T) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const c = currencyOf(it) || "SYP";
    out[c] = (out[c] ?? 0) + amountOf(it);
  }
  return out;
}

/** Add two per-currency breakdowns together, key by key — never across currencies. */
export function addCurrencyBreakdowns(
  a: Record<string, number>,
  b: Record<string, number>,
  sign: 1 | -1 = 1,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (out[k] ?? 0) + sign * v;
  }
  return out;
}

/** Format a number with thousands separators only (no symbol), e.g. 1_250_000 → "1,250,000". */
export function formatThousands(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return formatMoney(n);
}

/**
 * Parse a user-typed amount that may contain thousands separators
 * (e.g. "1,250,000") into a raw number. Returns NaN for invalid input.
 */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

export function setDefaultCurrency(c: Currency) {
  currencyState.defaultCurrency = c;
  // Notify subscribers via the store event
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("currency-change"));
  }
}

/** React hook — re-renders on currency state changes. */
export function useCurrencies() {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("currency-change", callback);
      return () => window.removeEventListener("currency-change", callback);
    },
    () => currencyState,
    () => currencyState,
  );
}
