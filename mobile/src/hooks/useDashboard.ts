// Home figures (core/dashboard.ts) as a query.
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { logError } from "../core/devlog";
import { loadDashboard } from "../core/dashboard";
import { queryKeys } from "./queryKeys";

export type { HomeData } from "../core/dashboard";

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: async () => {
      try {
        const app = await getApp();
        if (!app.phone) return null; // not enrolled yet: nothing to show, not an error
        return await loadDashboard(app.phone);
      } catch (error) {
        logError("home", error);
        throw error;
      }
    },
  });
}
