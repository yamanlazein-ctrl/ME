import { useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { sypRateDeviationWarning } from "@erp/shared";

/**
 * Backs the SYP exchange-rate soft-warning (product decision, 2026-09-22):
 * a manually-typed SYP rate that differs from the live LiraScope reference
 * rate by more than 30% shows a dismissible yellow confirmation, never a
 * block — a real preferential/contract rate can legitimately differ from the
 * market rate.
 *
 * This reads the SAME read-only backend endpoint the header's reference-rate
 * badge (`FxReferenceRate.tsx` / `FxApiService`) already uses. It does NOT
 * import that component and does not touch it — the badge stays exactly the
 * isolated, display-only widget its own governing-rule comment describes.
 * This hook only ever COMPARES the rate for a warning; it never writes to,
 * or reads from, any `exchangeRate` field, and the value returned here must
 * never be used to pre-fill one.
 */
export function useSypReferenceRateValue(): number | undefined {
  const { data } = useQuery({
    queryKey: ["fx", "reference-rate", "soft-check"],
    queryFn: ({ signal }) => {
      void signal;
      return container.fx.api.getReferenceRate();
    },
    staleTime: 5 * 60_000,
    // A rate warning is a nice-to-have, never a blocker — swallow failures
    // into "unavailable" instead of retrying loudly or breaking the form.
    retry: false,
  });
  if (!data?.available || typeof data.rate?.value !== "number") return undefined;
  // Provider publishes the NEW lira (two zeros dropped); documents use the old
  // lira — compare like with like or every correct rate looks 100× off.
  const v = data.rate.value;
  return v < 1000 ? v * 100 : v;
}

/** Convenience wrapper: null when the currency isn't SYP or no reference rate is loaded yet. */
export function useSypRateSoftWarning(
  currency: string,
  rate: number | null | undefined,
): string | null {
  const referenceRate = useSypReferenceRateValue();
  return sypRateDeviationWarning(currency, rate, referenceRate ?? null);
}
