import { useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import type { ProfitQueryParams } from "@/contracts/profit";

/**
 * React Query hooks for the profit center (summary/details/debts/expenses).
 *
 * Query key root `["profit"]` is exported so any mutation that changes the
 * financial picture (invoice create/update/cancel, vouchers, expenses,
 * returns, manual cash movements) can invalidate it — see the matching
 * invalidateQueries calls in useInvoices/useVouchers/useExpenses.
 */
export const PROFIT_QUERY_ROOT = ["profit"] as const;

const KEYS = {
  summary: (q?: ProfitQueryParams) => [...PROFIT_QUERY_ROOT, "summary", q ?? {}] as const,
  details: (q?: ProfitQueryParams) => [...PROFIT_QUERY_ROOT, "details", q ?? {}] as const,
};

/** GET /api/profit/summary — revenue/COGS/expenses/net per currency + debts. */
export function useProfitSummary(query?: ProfitQueryParams) {
  return useQuery({
    queryKey: KEYS.summary(query),
    queryFn: () => container.profit.api.summary(query),
    staleTime: 15_000,
  });
}

/** GET /api/profit/details — per-invoice rows + expenses drill-down. */
export function useProfitDetails(query?: ProfitQueryParams) {
  return useQuery({
    queryKey: KEYS.details(query),
    queryFn: () => container.profit.api.details(query),
    staleTime: 15_000,
  });
}