import { useState } from "react";
import { Alert } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../../../../src/core/appRuntime";
import { isAdminLike } from "../../../../src/core/roles";
import { listReturns, type ReturnListRow } from "../../../../src/core/returns";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { useRole } from "../../../../src/hooks/useRole";
import { SendToCustomer } from "../../../../src/ui/SendToCustomer";
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
      rows={data ?? []}
      canCancel={isAdminLike(role)}
      error={error}
      sendSlot={(row) => <SendToCustomer docRef={{ type: "return", id: row.id }} />}
      onCancel={(row) =>
        Alert.alert("إلغاء المرتجع", `هل تريد إلغاء المرتجع ${row.number}؟`, [
          { text: "رجوع", style: "cancel" },
          { text: "إلغاء المرتجع", style: "destructive", onPress: () => void cancel(row) },
        ])
      }
    />
  );
}
