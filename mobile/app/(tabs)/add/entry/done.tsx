import { router, useLocalSearchParams } from "expo-router";
import { SharePdfButton } from "../../../../src/ui/SendToCustomer";
import { DocumentDoneView, SAVED_LOCALLY_NOTE } from "../../../../src/ui/SaleViews";

export default function EntryDone() {
  const { id, number } = useLocalSearchParams<{ id: string; number: string }>();
  return (
    <DocumentDoneView
      title="فاتورة الدخول"
      number={number}
      note={SAVED_LOCALLY_NOTE}
      shareSlot={<SharePdfButton docRef={{ type: "invoice", id }} />}
      onOpen={() => router.push(`/invoices/${id}` as never)}
      onNew={() => router.replace("/(tabs)/add/entry" as never)}
      newLabel="فاتورة دخول جديدة"
    />
  );
}
