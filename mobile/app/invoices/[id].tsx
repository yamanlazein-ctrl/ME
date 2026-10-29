import { useState } from "react";
import { ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApp } from "../../src/core/appRuntime";
import { loadInvoiceView } from "../../src/core/invoiceView";
import { queryKeys } from "../../src/hooks/queryKeys";
import { useFinishWrite } from "../../src/hooks/useFinishWrite";
import { useRole } from "../../src/hooks/useRole";
import { shareInvoicePdf } from "../../src/print/shareInvoice";
import { SharePdfButton } from "../../src/ui/SendToCustomer";
import { InvoiceDetailView } from "../../src/ui/InvoiceDetailView";

export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const finish = useFinishWrite();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: queryKeys.invoice(id),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadInvoiceView(app.phone, id) : null;
    },
  });
  if (!data) return <ActivityIndicator style={{ flex: 1 }} />;

  const cancel = async () => {
    setError(null);
    const app = await getApp();
    if (!app.phone) return;
    const result = await app.phone.documents.cancelInvoice(id, data.invoice.version);
    if (!result.ok) return setError(result.error);
    await finish();
    await qc.invalidateQueries({ queryKey: queryKeys.invoice(id) });
  };

  return (
    <InvoiceDetailView
      view={data}
      role={role}
      error={error}
      sendSlot={<SharePdfButton docRef={{ type: "invoice", id }} />}
      onShare={() => void shareInvoicePdf(id).catch((e: unknown) => setError(String(e)))}
      onCancel={() =>
        Alert.alert("إلغاء الفاتورة", `هل تريد إلغاء الفاتورة ${data.invoice.number}؟`, [
          { text: "رجوع", style: "cancel" },
          { text: "إلغاء الفاتورة", style: "destructive", onPress: () => void cancel() },
        ])
      }
    />
  );
}
