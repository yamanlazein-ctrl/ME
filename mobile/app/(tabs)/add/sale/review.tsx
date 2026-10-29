import { useState } from "react";
import { router } from "expo-router";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../../src/core/appRuntime";
import { draftProblems, toCreateInput } from "../../../../src/core/saleDraft";
import { saleDraftStore, useSaleDraft } from "../../../../src/hooks/useSaleDraft";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { SaleReviewView } from "../../../../src/ui/SaleViews";

export default function SaleReview() {
  const draft = useSaleDraft();
  const finish = useFinishWrite();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (draftProblems(draft).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      // One call: number + header + lines + ledger + voucher + cashbox + stock in one transaction (FR-15).
      const result = await app.phone.documents.createInvoice(
        toCreateInput(draft, localDateISO(new Date())),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await finish();
      saleDraftStore.reset();
      router.replace({
        pathname: "/(tabs)/add/sale/done",
        params: { id: result.data.id, number: result.data.number },
      } as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SaleReviewView
      draft={draft}
      busy={busy}
      error={error}
      onPatch={(patch) => saleDraftStore.update(patch)}
      onSave={() => void save()}
    />
  );
}
