// The phone counterpart of the frontend rule: any financial write refreshes every view that shows money.
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

export function invalidateFinancialViews(
  qc: Pick<QueryClient, "invalidateQueries">,
): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.dashboard }),
    qc.invalidateQueries({ queryKey: queryKeys.parties }),
    qc.invalidateQueries({ queryKey: ["statements"] }),
    qc.invalidateQueries({ queryKey: queryKeys.cashbox }),
    qc.invalidateQueries({ queryKey: queryKeys.invoices }),
    qc.invalidateQueries({ queryKey: queryKeys.inventory }),
    qc.invalidateQueries({ queryKey: ["reports"] }),
    qc.invalidateQueries({ queryKey: ["returns"] }),
    qc.invalidateQueries({ queryKey: ["orders"] }),
    qc.invalidateQueries({ queryKey: queryKeys.sync }),
  ]);
}
