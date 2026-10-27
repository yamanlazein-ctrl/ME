import { useState } from "react";
import { ActivityIndicator, Alert } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../../../../src/core/appRuntime";
import { listFulfilCandidates, loadOrder } from "../../../../src/core/orders";
import { canWriteOffline } from "../../../../src/core/roles";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { useRole } from "../../../../src/hooks/useRole";
import { OrderDetailView } from "../../../../src/ui/OrderViews";

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["orders", id],
    queryFn: async () => {
      const app = await getApp();
      if (!app.phone) return null;
      const detail = await loadOrder(app.phone, id);
      const candidates = detail?.order.customerId
        ? await listFulfilCandidates(app.phone, detail.order.customerId)
        : [];
      return detail ? { detail, candidates } : null;
    },
  });
  if (!data) return <ActivityIndicator style={{ flex: 1 }} />;
  const run = async (
    action: (
      p: NonNullable<Awaited<ReturnType<typeof getApp>>["phone"]>,
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
  ) => {
    setError(null);
    const app = await getApp();
    if (!app.phone) return;
    const r = await action(app.phone);
    if (!r.ok) return setError(r.error);
    await finish();
    router.back();
  };
  return (
    <OrderDetailView
      detail={data.detail}
      canWrite={canWriteOffline(role)}
      candidates={data.candidates}
      error={error}
      onCancel={() =>
        Alert.alert("إلغاء الطلبية", `هل تريد إلغاء الطلبية ${data.detail.order.code}؟`, [
          { text: "رجوع", style: "cancel" },
          {
            text: "إلغاء الطلبية",
            style: "destructive",
            onPress: () => void run((p) => p.documents.cancelOrder(id, data.detail.order.version)),
          },
        ])
      }
      onFulfil={(invoiceId) => void run((p) => p.documents.fulfillOrder(id, invoiceId))}
    />
  );
}
