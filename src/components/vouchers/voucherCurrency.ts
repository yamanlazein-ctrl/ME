/**
 * Which currency a voucher should open in when a party is chosen.
 *
 * Rule (pure, so it is tested exactly):
 *   1. The party's currency with the largest non-zero ledger balance (its real outstanding debt
 *      or credit, e.g. a USD opening) — the badge then shows the balance instead of "متوازن".
 *   2. Otherwise the party's own default currency.
 *   3. Otherwise `fallback` (the form's SYP default).
 *
 * The cashier can always change the currency afterwards; this only chooses the starting point.
 */
export type CurrencyBalances = Record<string, { remaining?: number } | undefined>;

export function currencyForParty(
  party: { currency?: string | null; stats?: { byCurrency?: CurrencyBalances } } | undefined,
  fallback: string = "SYP",
): string {
  if (!party) return fallback;
  const held = Object.entries(party.stats?.byCurrency ?? {})
    .map(([code, b]) => ({ code, abs: Math.abs(b?.remaining ?? 0) }))
    .filter((x) => x.abs >= 0.005)
    .sort((a, b) => b.abs - a.abs || a.code.localeCompare(b.code));
  if (held.length > 0) return held[0]!.code;
  return party.currency || fallback;
}
