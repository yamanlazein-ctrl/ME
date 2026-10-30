import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { loadCountSheet } from "../core/inventory";
import { queryKeys } from "./queryKeys";

export function useCountSheet(year: number, q: string) {
  return useQuery({
    queryKey: queryKeys.countSheet(year, q),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadCountSheet(app.phone, year, q) : { lines: [], total: 0 };
    },
  });
}
