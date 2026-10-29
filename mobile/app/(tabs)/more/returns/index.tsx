import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { getApp } from "../../../../src/core/appRuntime";
import { canWriteOffline, isAdminLike } from "../../../../src/core/roles";
import { listReturns, type ReturnListRow } from "../../../../src/core/returns";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { useRole } from "../../../../src/hooks/useRole";
import { SharePdfButton } from "../../../../src/ui/SendToCustomer";
import { ReturnListView } from "../../../../src/ui/ReturnViews";

export default function Returns() {
  const role = useRole();
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const { data, refetch } = useQuery({
    queryKey: ["returns"],
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? listReturns(app.phone) : [];
    },
  });
  const cancel = async (row: ReturnListRow) => {
    setError(null);
    const app = await getApp();
    if (!app.phone) return;
    const r = await app.phone.documents.cancelReturn(row.id, row.version);
    if (!r.ok) return setError(r.error);
    await finish();
    await refetch();
  };
  return (
    <ReturnListView
      rows={data}
      canCancel={isAdminLike(role)}
      error={error}
      sendSlot={(row) => <SharePdfButton docRef={{ type: "return", id: row.id }} />}
      onCancel={cancel}
      {...(canWriteOffline(role)
        ? { onNew: () => router.push("/(tabs)/add/return" as never) }
        : {})}
    />
  );
}
