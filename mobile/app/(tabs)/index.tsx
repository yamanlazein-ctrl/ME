import { router } from "expo-router";
import { useDashboard } from "../../src/hooks/useDashboard";
import { useRole } from "../../src/hooks/useRole";
import { useSyncStatus } from "../../src/hooks/useSyncStatus";
import { HomeView, type HomeAction } from "../../src/ui/HomeView";

// Targets of the quick actions and the follow-up rows.
const TARGET: Record<HomeAction, string> = {
  sale: "/(tabs)/add/sale",
  entry: "/(tabs)/add/entry",
  receipt: "/(tabs)/add/receipt",
  payment: "/(tabs)/add/payment",
  expense: "/(tabs)/add/expense",
  findParty: "/(tabs)/parties",
  inventory: "/(tabs)/inventory",
  orders: "/(tabs)/more/orders",
  sync: "/(tabs)/more/sync",
};

export default function Home() {
  const dashboard = useDashboard();
  const status = useSyncStatus();
  const role = useRole();
  return (
    <HomeView
      data={dashboard.data}
      loading={dashboard.isLoading}
      error={dashboard.error}
      role={role}
      lastSyncAt={status.lastRunAt}
      refreshing={dashboard.isRefetching}
      onRefresh={() => void dashboard.refetch()}
      onAction={(a) => router.push(TARGET[a] as never)}
    />
  );
}
