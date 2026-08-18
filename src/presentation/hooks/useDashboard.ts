import { useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";

const KEYS = {
  data: ["dashboard"] as const,
};

export function useDashboard() {
  return useQuery({
    queryKey: KEYS.data,
    // Build the context at query time (not module scope) so the dashboard
    // always queries with the *current* authenticated tenant/user — not a
    // stale context captured before login. Combined with refetchOnMount +
    // refetchInterval, a newly-created invoice is reflected in "فواتير اليوم"
    // as soon as the dashboard is shown.
    queryFn: ({ signal }) => {
      void signal;
      const ctx = buildTenantContext();
      return container.dashboard.get.execute(ctx);
    },
    staleTime: 30_000,
    // Always refetch when the dashboard is mounted so KPIs like
    // "فواتير اليوم" reflect invoices created moments ago — not stale cache.
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // Safety net: keep the dashboard fresh even if invalidation/refocus is
    // missed, so new invoices/receipts show up within this window.
    refetchInterval: 30_000,
  });
}
