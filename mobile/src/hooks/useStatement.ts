import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { loadFullStatement, type FullStatement } from "../core/partyQueries";
import { queryKeys } from "./queryKeys";

export function useStatement(partyId: string, kind: "customer" | "supplier", currency?: string) {
  return useQuery({
    queryKey: [...queryKeys.statement(partyId), kind, currency ?? "ALL"],
    queryFn: async (): Promise<FullStatement> => {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      return loadFullStatement(app.phone, { partyId, kind, ...(currency ? { currency } : {}) });
    },
  });
}
