import { router, useLocalSearchParams } from "expo-router";
import { SharePdfButton } from "../../../../src/ui/SendToCustomer";
import { DocumentDoneView, SAVED_LOCALLY_NOTE } from "../../../../src/ui/SaleViews";

export default function SaleDone() {
  const { id, number } = useLocalSearchParams<{ id: string; number: string }>();
  return (
    <DocumentDoneView
      title="فاتورة البيع"
      number={number}
      note={SAVED_LOCALLY_NOTE}
      shareSlot={<SharePdfButton docRef={{ type: "invoice", id }} variant="primary" />}
      onOpen={() => router.push(`/invoices/${id}` as never)}
      onNew={() => router.replace("/(tabs)/add/sale" as never)}
      newLabel="فاتورة بيع جديدة"
    />
  );
}
