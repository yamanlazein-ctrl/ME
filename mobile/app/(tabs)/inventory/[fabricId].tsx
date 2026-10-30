import { router, useLocalSearchParams } from "expo-router";
import { useFabric } from "../../../src/hooks/useStock";
import { FabricView } from "../../../src/ui/InventoryViews";
import { ErrorState, LoadingState, readErrorText, Screen } from "../../../src/ui/kit";

export default function FabricScreen() {
  const { fabricId } = useLocalSearchParams<{ fabricId: string }>();
  const q = useFabric(fabricId);
  if (q.data)
    return (
      <FabricView
        detail={q.data}
        onOpenColor={(id) => router.push(`/(tabs)/inventory/color/${id}` as never)}
      />
    );
  return (
    <Screen title="القماش">
      {q.isLoading ? (
        <LoadingState />
      ) : (
        <ErrorState
          message={q.error ? readErrorText(q.error) : "هذا القماش غير موجود على الهاتف."}
          onRetry={() => void q.refetch()}
        />
      )}
    </Screen>
  );
}
