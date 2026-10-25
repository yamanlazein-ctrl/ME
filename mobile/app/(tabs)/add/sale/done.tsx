import { router, useLocalSearchParams } from "expo-router";
import { shareInvoicePdf } from "../../../../src/print/shareInvoice";
import { SaleDoneView } from "../../../../src/ui/SaleViews";

export default function SaleDone() {
  const { id, number } = useLocalSearchParams<{ id: string; number: string }>();
  return (
    <SaleDoneView
      number={number}
      onSharePdf={() => void shareInvoicePdf(id)}
      onOpen={() => router.replace(`/invoices/${id}` as never)}
      onNew={() => router.replace("/(tabs)/add/sale/customer" as never)}
    />
  );
}
