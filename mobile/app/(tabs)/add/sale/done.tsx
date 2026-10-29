import { router, useLocalSearchParams } from "expo-router";
import { shareInvoicePdf } from "../../../../src/print/shareInvoice";
import { SharePdfButton } from "../../../../src/ui/SendToCustomer";
import { SaleDoneView } from "../../../../src/ui/SaleViews";

export default function SaleDone() {
  const { id, number } = useLocalSearchParams<{ id: string; number: string }>();
  return (
    <SaleDoneView
      number={number}
      onSharePdf={() => void shareInvoicePdf(id)}
      onOpen={() => router.push(`/invoices/${id}` as never)}
      sendSlot={<SharePdfButton docRef={{ type: "invoice", id }} />}
      onNew={() => router.replace("/(tabs)/add/sale/customer" as never)}
    />
  );
}
