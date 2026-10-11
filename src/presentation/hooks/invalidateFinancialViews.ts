import type { QueryClient } from "@tanstack/react-query";
import { refreshParties } from "./useParties";

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
  qc.invalidateQueries({ queryKey: ["party"] }); // usePartyBalance
  qc.invalidateQueries({ queryKey: ["parties"] }); // party list/detail queries
  // The party list screens render `stats` from useParties' module cache, which no React Query
  // invalidation reaches (FE-02) — refresh it here so every financial mutation updates the list.
  void refreshParties();
  // Order fulfill / invoice-adjacent mutations.
  qc.invalidateQueries({ queryKey: ["invoices"] });
  if (options.refetchDashboard) {
    qc.refetchQueries({ queryKey: ["dashboard"] });
  }
}
