import { useState } from "react";
import { router } from "expo-router";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../../src/core/appRuntime";
import { entryProblems, toEntryInput } from "../../../../src/core/entryDraft";
import { entryDraftStore, useEntryDraft } from "../../../../src/hooks/useEntryDraft";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { EntryReviewView } from "../../../../src/ui/EntryViews";

export default function EntryReview() {
  const draft = useEntryDraft();
  const finish = useFinishWrite();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (entryProblems(draft).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      // One call: new fabrics, colours and rolls + invoice + ledger + stock in ONE transaction (FR-16).
      const result = await app.phone.documents.createEntryInvoice(
        toEntryInput(draft, localDateISO(new Date())),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await finish();
      entryDraftStore.reset();
      router.replace({
        pathname: "/(tabs)/add/entry/done",
        params: { id: result.data.id, number: result.data.number },
      } as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <EntryReviewView
      draft={draft}
      busy={busy}
      error={error}
      onPatch={(patch) => entryDraftStore.update(patch)}
      onSave={() => void save()}
    />
  );
}
