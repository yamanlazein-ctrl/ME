import { useState } from "react";
import { router } from "expo-router";
import { canWriteOffline } from "../../../src/core/roles";
import type { StockFilter } from "../../../src/core/stock";
import { useCategories, useFabrics, useLotSearch } from "../../../src/hooks/useStock";
import { useRole } from "../../../src/hooks/useRole";
import { StockListView } from "../../../src/ui/InventoryViews";

export default function Inventory() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StockFilter>("all");
  const [category, setCategory] = useState<string | null>(null);
  const fabrics = useFabrics(q, filter, category);
  const categories = useCategories();
  const lots = useLotSearch(q);
  const role = useRole();
  return (
    <StockListView
      q={q}
      filter={filter}
      category={category}
      categories={categories.data ?? []}
      rows={fabrics.data}
      lots={q.trim().length >= 2 ? (lots.data ?? []) : []}
      loading={fabrics.isLoading}
      error={fabrics.error}
      refreshing={fabrics.isRefetching}
      canCount={canWriteOffline(role)}
      onQuery={setQ}
      onFilter={setFilter}
      onCategory={setCategory}
      onRefresh={() => void fabrics.refetch()}
      onRetry={() => void fabrics.refetch()}
      onOpenFabric={(id) => router.push(`/(tabs)/inventory/${id}` as never)}
      onOpenLot={(id) => router.push(`/(tabs)/inventory/roll/${id}` as never)}
      onCount={() => router.push("/(tabs)/inventory/count" as never)}
    />
  );
}
