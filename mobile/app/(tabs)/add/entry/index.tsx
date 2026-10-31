import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../../src/core/appRuntime";
import { entryProblems, toEntryInput } from "../../../../src/core/entryDraft";
import { entryDraftStore, useEntryDraft } from "../../../../src/hooks/useEntryDraft";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { EntryFormView } from "../../../../src/ui/EntryViews";

export default function EntryForm() {
  const draft = useEntryDraft();
  const finish = useFinishWrite();
  const { partyId } = useLocalSearchParams<{ partyId?: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!partyId || entryDraftStore.get().supplier?.id === partyId) return;
    if (entryDraftStore.get().lines.length > 0) return;
    void getApp().then(async (app) => {
      const party = app.phone
        ? await app.phone.repos.partyRepo.findById(partyId, app.phone.context())
        : null;
      if (party) entryDraftStore.update({ supplier: { id: party.id, name: party.name } });
    });
  }, [partyId]);

  return (
    <EntryFormView
      draft={draft}
      error={error}
      today={localDateISO(new Date())}
      onSupplier={(supplier) => entryDraftStore.update({ supplier })}
      onCurrency={(currency) => entryDraftStore.update({ currency })}
      onRate={(exchangeRate) => entryDraftStore.update({ exchangeRate })}
      onAddLine={() => router.push("/(tabs)/add/entry/line" as never)}
      onCopyLine={(key) =>
        router.push({ pathname: "/(tabs)/add/entry/line", params: { copy: key } } as never)
      }
      onEditLine={(key) =>
        router.push({ pathname: "/(tabs)/add/entry/line", params: { edit: key } } as never)
      }
      onRemoveLine={(key) =>
        entryDraftStore.update({ lines: entryDraftStore.get().lines.filter((l) => l.key !== key) })
      }
      onPatch={(patch) => entryDraftStore.update(patch)}
      onDiscard={() => {
        setError(null);
        entryDraftStore.reset();
      }}
      onSave={async () => {
        const current = entryDraftStore.get();
        if (entryProblems(current).length > 0) return;
        setError(null);
        try {
          const app = await getApp();
          if (!app.phone) throw new Error("الجهاز غير مسجّل");
          const result = await app.phone.documents.createEntryInvoice(
            toEntryInput(current, localDateISO(new Date())),
          );
          if (!result.ok) return setError(result.error);
          await finish();
          entryDraftStore.reset();
          router.replace({
            pathname: "/(tabs)/add/entry/done",
            params: { id: result.data.id, number: result.data.number },
          } as never);
        } catch (e) {
          setError(e instanceof Error ? e.message : "تعذّر الحفظ");
        }
      }}
    />
  );
}
