import { router, useLocalSearchParams } from "expo-router";
import { EntryDoneView } from "../../../../src/ui/EntryViews";

export default function EntryDone() {
  const { id, number } = useLocalSearchParams<{ id: string; number: string }>();
  return (
    <EntryDoneView
      number={number}
      onOpen={() => router.replace(`/invoices/${id}` as never)}
      onNew={() => router.replace("/(tabs)/add/entry" as never)}
    />
  );
}
