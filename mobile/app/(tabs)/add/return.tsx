import { useState } from "react";
import { router } from "expo-router";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../src/core/appRuntime";
import {
  emptyReturnDraft,
  listSourceInvoices,
  loadReturnableLines,
  returnProblems,
  toReturnInput,
  type ReturnDraft,
  type SourceInvoiceRow,
} from "../../../src/core/returns";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { ReturnFormView } from "../../../src/ui/ReturnViews";

export default function ReturnScreen() {
  const finish = useFinishWrite();
  const [draft, setDraft] = useState<ReturnDraft>(emptyReturnDraft("sale"));
  const [invoices, setInvoices] = useState<SourceInvoiceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = async () => {
    const app = await getApp();
    if (!app.phone) throw new Error("الجهاز غير مسجّل");
    return app.phone;
  };
  const save = async () => {
    if (returnProblems(draft).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await (
        await phone()
      ).documents.createReturn(toReturnInput(draft, localDateISO(new Date())));
      if (!result.ok) return setError(result.error);
      await finish();
      router.replace("/(tabs)/more/returns" as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ReturnFormView
      draft={draft}
      invoices={invoices}
      busy={busy}
      error={error}
      onKind={(kind) => {
        setInvoices([]);
        setDraft(emptyReturnDraft(kind));
      }}
      onParty={(party) => {
        setDraft((d) => ({ ...d, party, invoice: null, lines: [], qty: {} }));
        void phone().then(async (p) =>
          setInvoices(await listSourceInvoices(p, draft.kind, party.id)),
        );
      }}
      onInvoice={(invoice) => {
        void phone().then(async (p) => {
          const loaded = await loadReturnableLines(p, invoice.id);
          setDraft((d) => ({
            ...d,
            invoice,
            currency: loaded?.currency ?? d.currency,
            lines: loaded?.lines ?? [],
            qty: {},
          }));
        });
      }}
      onQty={(rollId, patch) =>
        setDraft((d) => ({
          ...d,
          qty: { ...d.qty, [rollId]: { ...(d.qty[rollId] ?? { kg: 0, pieces: 0 }), ...patch } },
        }))
      }
      onReason={(reason) => setDraft((d) => ({ ...d, reason }))}
      onSave={() => void save()}
    />
  );
}
