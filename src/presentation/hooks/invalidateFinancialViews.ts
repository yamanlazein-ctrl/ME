import type { QueryClient } from "@tanstack/react-query";

/**
 * Central financial query invalidation (DFP-016 / DFP-017).
 *
 * Party / order / invoice mutations change balances, ledger legs, statements,
 * dashboard KPIs, cashbox, and profit. Call sites must not invent ad-hoc
 * subsets — use this helper so every derived view refreshes together.
 */
export function invalidateFinancialViews(
  qc: QueryClient,
  options: { refetchDashboard?: boolean } = {},
): void {
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["cashbox"] });
  qc.invalidateQueries({ queryKey: ["ledger"] });
  qc.invalidateQueries({ queryKey: ["profit"] });
  qc.invalidateQueries({ queryKey: ["statement"] });
  qc.invalidateQueries({ queryKey: ["party"] });
  // Order fulfill / invoice-adjacent mutations.
  qc.invalidateQueries({ queryKey: ["invoices"] });
  if (options.refetchDashboard) {
    qc.refetchQueries({ queryKey: ["dashboard"] });
  }
}
