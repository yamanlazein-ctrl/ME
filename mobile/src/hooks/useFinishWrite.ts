import { useQueryClient } from "@tanstack/react-query";
import { notifyLocalWrite } from "../core/syncRunner";
import { invalidateFinancialViews } from "./invalidate";

/** After a successful local write: wake the sync loop and refresh every view that shows money (FR-09, FR-13). */
export function useFinishWrite() {
  const qc = useQueryClient();
  return async () => {
    notifyLocalWrite();
    await invalidateFinancialViews(qc);
  };
}
