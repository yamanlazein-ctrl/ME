import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApp } from "../../src/core/appRuntime";
import { runPhoneAction } from "../../src/core/phoneAction";
import { loadInvoiceView } from "../../src/core/invoiceView";
import { queryKeys } from "../../src/hooks/queryKeys";
import { useFinishWrite } from "../../src/hooks/useFinishWrite";
import { useRole } from "../../src/hooks/useRole";
import { SharePdfButton } from "../../src/ui/SendToCustomer";
import { InvoiceDetailView } from "../../src/ui/InvoiceDetailView";
import { ErrorState, LoadingState, readErrorText, Screen } from "../../src/ui/kit";

export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const finish = useFinishWrite();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: queryKeys.invoice(id),
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadInvoiceView(app.phone, id) : null;
    },
  });
  const data = q.data;
  if (!data)
    return (
      <Screen title="الفاتورة">
        {q.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState
            message={q.error ? readErrorText(q.error) : "هذه الفاتورة غير موجودة على الهاتف."}
            onRetry={() => void q.refetch()}
          />
        )}
      </Screen>
    );

  return (
    <InvoiceDetailView
      view={data}
      role={role}
      error={error}
      shareSlot={<SharePdfButton docRef={{ type: "invoice", id }} variant="primary" />}
      onOpenParty={() => router.push(`/(tabs)/parties/${data.invoice.partyId}` as never)}
      onNewVoucher={() =>
        router.push({
          pathname: data.invoice.type === "sale" ? "/(tabs)/add/receipt" : "/(tabs)/add/payment",
          params: { partyId: data.invoice.partyId, invoiceId: id },
        } as never)
      }
      onCancel={async () => {
        setError(null);
        const result = await runPhoneAction(
          "invoice-cancel",
          (phone) => phone.documents.cancelInvoice(id, data.invoice.version),
          setError,
        );
        if (!result) return;
        if (!result.ok) return setError(result.error);
        await finish();
        await qc.invalidateQueries({ queryKey: queryKeys.invoice(id) });
      }}
    />
  );
}
