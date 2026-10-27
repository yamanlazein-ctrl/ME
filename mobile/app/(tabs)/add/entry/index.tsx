import { router } from "expo-router";
import { entryDraftStore, useEntryDraft } from "../../../../src/hooks/useEntryDraft";
import { EntrySupplierView } from "../../../../src/ui/EntryViews";

export default function EntrySupplier() {
  const draft = useEntryDraft();
  return (
    <EntrySupplierView
      draft={draft}
      onSupplier={(supplier) => entryDraftStore.update({ supplier })}
      onCurrency={(currency) => entryDraftStore.update({ currency })}
      onRate={(exchangeRate) => entryDraftStore.update({ exchangeRate })}
      onNext={() => router.push("/(tabs)/add/entry/lines" as never)}
    />
  );
}
