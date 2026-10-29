import { useState } from "react";
import { router } from "expo-router";
import { useFabricStock } from "../../../src/hooks/useInventory";
import { useRole } from "../../../src/hooks/useRole";
import { FabricListView } from "../../../src/ui/InventoryViews";

export default function Inventory() {
  const [q, setQ] = useState("");
  const { data } = useFabricStock(q);
  const role = useRole();
  return (
    <FabricListView
      rows={data ?? []}
      q={q}
      role={role}
      onQuery={setQ}
      onOpen={(id) => router.push(`/(tabs)/inventory/${id}` as never)}
      onCount={() => router.push("/(tabs)/inventory/count" as never)}
    />
  );
}
