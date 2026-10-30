import { router, useLocalSearchParams } from "expo-router";
import { useColorLots } from "../../../../src/hooks/useStock";
import { ColorLotsView } from "../../../../src/ui/InventoryViews";
import { ErrorState, LoadingState, readErrorText, Screen } from "../../../../src/ui/kit";

export default function ColorScreen() {
  const { colorId } = useLocalSearchParams<{ colorId: string }>();
  const q = useColorLots(colorId);
  if (q.data)
    return (
      <ColorLotsView
        data={q.data}
        onOpenLot={(id) => router.push(`/(tabs)/inventory/roll/${id}` as never)}
      />
    );
  return (
    <Screen title="اللون">
      {q.isLoading ? (
        <LoadingState />
      ) : (
        <ErrorState
          message={q.error ? readErrorText(q.error) : "هذا اللون غير موجود على الهاتف."}
          onRetry={() => void q.refetch()}
        />
      )}
    </Screen>
  );
}
