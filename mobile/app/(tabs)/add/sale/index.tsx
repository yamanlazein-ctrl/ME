import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { randomUUID } from "node:crypto";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../../src/core/appRuntime";
import { draftProblems, toCreateInput } from "../../../../src/core/saleDraft";
import { saleDraftStore, useSaleDraft } from "../../../../src/hooks/useSaleDraft";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import { lineFromLot, SaleFormView } from "../../../../src/ui/SaleViews";

export default function SaleForm() {
  const draft = useSaleDraft();
  const finish = useFinishWrite();
  const { partyId } = useLocalSearchParams<{ partyId?: string }>();
  const [error, setError] = useState<string | null>(null);

  // Opened from a customer's page: that customer, unless a draft for another one is in progress.
  useEffect(() => {
    if (!partyId || saleDraftStore.get().party?.id === partyId) return;
    if (saleDraftStore.get().lines.length > 0) return;
    void getApp().then(async (app) => {
      const party = app.phone
        ? await app.phone.repos.partyRepo.findById(partyId, app.phone.context())
        : null;
      if (party) saleDraftStore.update({ party: { id: party.id, name: party.name } });
    });
  }, [partyId]);

  return (
    <SaleFormView
      draft={draft}
      error={error}
      onParty={(party) => saleDraftStore.update({ party })}
      onCurrency={(currency) => saleDraftStore.update({ currency })}
      onRate={(exchangeRate) => saleDraftStore.update({ exchangeRate })}
      onAddLot={(lot) =>
        saleDraftStore.update({
          lines: [...saleDraftStore.get().lines, lineFromLot(lot, randomUUID())],
        })
      }
      onEditLine={(key, patch) =>
        saleDraftStore.update({
          lines: saleDraftStore.get().lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
        })
      }
      onRemoveLine={(key) =>
        saleDraftStore.update({ lines: saleDraftStore.get().lines.filter((l) => l.key !== key) })
      }
      onPatch={(patch) => saleDraftStore.update(patch)}
      onDiscard={() => {
        setError(null);
        saleDraftStore.reset();
      }}
      onSave={async () => {
        const current = saleDraftStore.get();
        if (draftProblems(current).length > 0) return;
        setError(null);
        try {
          const app = await getApp();
          if (!app.phone) throw new Error("الجهاز غير مسجّل");
          // One call: number + header + lines + ledger + voucher + cashbox + stock in one transaction (FR-15).
          const result = await app.phone.documents.createInvoice(
            toCreateInput(current, localDateISO(new Date())),
          );
          if (!result.ok) return setError(result.error);
          await finish();
          saleDraftStore.reset();
          router.replace({
            pathname: "/(tabs)/add/sale/done",
            params: { id: result.data.id, number: result.data.number },
          } as never);
        } catch (e) {
          setError(e instanceof Error ? e.message : "تعذّر الحفظ");
        }
      }}
    />
  );
}
