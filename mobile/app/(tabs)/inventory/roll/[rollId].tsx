import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { getApp } from "../../../../src/core/appRuntime";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { useRole } from "../../../../src/hooks/useRole";
import { useLot } from "../../../../src/hooks/useStock";
import { LotView } from "../../../../src/ui/InventoryViews";
import { kg } from "../../../../src/ui/format";
import { ErrorState, LoadingState, readErrorText, Screen } from "../../../../src/ui/kit";

export default function LotScreen() {
  const { rollId } = useLocalSearchParams<{ rollId: string }>();
  const q = useLot(rollId);
  const role = useRole();
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lot = q.data;
  if (!lot)
    return (
      <Screen title="الصبغة">
        {q.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState
            message={q.error ? readErrorText(q.error) : "هذه الصبغة غير موجودة على الهاتف."}
            onRetry={() => void q.refetch()}
          />
        )}
      </Screen>
    );
  return (
    <LotView
      lot={lot}
      role={role}
      error={error}
      notice={notice}
      onOpenReference={(m) => m.referenceId && router.push(`/invoices/${m.referenceId}` as never)}
      onAdjust={async ({ newKg, reason }) => {
        setError(null);
        setNotice(null);
        const app = await getApp();
        if (!app.phone) return setError("الجهاز غير مسجّل");
        const result = await app.phone.documents.adjustRoll(rollId, {
          newKg,
          reason,
          expectedVersion: lot.version,
        });
        if (!result.ok) return setError(result.error);
        await finish();
        setNotice(`حُفظ التعديل: المتبقي الآن ${kg(newKg)}`);
      }}
    />
  );
}
