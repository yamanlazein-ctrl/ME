import { ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useColorRolls, useColorStock, useFabricStock } from "../../../src/hooks/useInventory";
import { FabricDetailView, RollRows } from "../../../src/ui/InventoryViews";

function Rolls({ colorId }: { colorId: string }) {
  const { data } = useColorRolls(colorId, true);
  if (!data) return <ActivityIndicator />;
  return (
    <RollRows rolls={data} onOpen={(id) => router.push(`/(tabs)/inventory/roll/${id}` as never)} />
  );
}

export default function FabricScreen() {
  const { fabricId } = useLocalSearchParams<{ fabricId: string }>();
  const colorsQuery = useColorStock(fabricId);
  const fabrics = useFabricStock("");
  const name = fabrics.data?.find((f) => f.id === fabricId)?.name ?? "";
  if (!colorsQuery.data) return <ActivityIndicator style={{ flex: 1 }} />;
  return (
    <FabricDetailView
      name={name}
      rows={colorsQuery.data}
      rollsOf={(colorId) => <Rolls colorId={colorId} />}
      onOpenRoll={(id) => router.push(`/(tabs)/inventory/roll/${id}` as never)}
    />
  );
}
