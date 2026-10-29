import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { getApp } from "../../../../src/core/appRuntime";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { useRole } from "../../../../src/hooks/useRole";
import { useRollDetail } from "../../../../src/hooks/useInventory";
import { RollDetailView } from "../../../../src/ui/InventoryViews";

export default function RollScreen() {
  const { rollId } = useLocalSearchParams<{ rollId: string }>();
  const { data } = useRollDetail(rollId);
  const role = useRole();
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <ActivityIndicator style={{ flex: 1 }} />;
  return (
    <RollDetailView
      detail={data}
      role={role}
      error={error}
      busy={busy}
      onAdjust={async ({ newKg, reason }) => {
        setBusy(true);
        setError(null);
        try {
          const app = await getApp();
          if (!app.phone) return;
          const result = await app.phone.documents.adjustRoll(rollId, {
            newKg,
            reason,
            expectedVersion: data.roll.version,
          });
          if (!result.ok) return setError(result.error);
          await finish();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
