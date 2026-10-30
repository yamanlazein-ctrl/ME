import { useEffect, useState } from "react";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../core/appRuntime";
import { partyBalances } from "../core/parties";
import { queryKeys } from "../hooks/queryKeys";
import { useFinishWrite } from "../hooks/useFinishWrite";
import { SharePdfButton } from "./SendToCustomer";
import { DocumentDoneView, SAVED_LOCALLY_NOTE } from "./SaleViews";
import {
  emptyVoucher,
  VoucherForm,
  voucherProblems,
  type VoucherFormValues,
  type VoucherMethod,
} from "./VoucherForm";

/**
 * Receipt/payment screen. `partyId` preselects the party (from its page); with `amendId` it loads the voucher and saves
 * through the replace use-case in one call (FR-21).
 */
export function VoucherScreen({
  kind,
  amendId,
  partyId,
}: {
  kind: "receipt" | "payment";
  amendId?: string;
  partyId?: string;
}) {
  const finish = useFinishWrite();
  const [values, setValues] = useState<VoucherFormValues>(emptyVoucher());
  const [original, setOriginal] = useState<{ version: number; amount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [done, setDone] = useState<{ id: string; number: string } | null>(null);
  const partyKind: "customer" | "supplier" = kind === "receipt" ? "customer" : "supplier";

  const balances = useQuery({
    queryKey: [...queryKeys.party(values.party?.id ?? ""), "balances"],
    enabled: Boolean(values.party),
    queryFn: async () => {
      const app = await getApp();
      if (!app.phone || !values.party) return [];
      return partyBalances(app.phone, values.party.id, partyKind);
    },
  });

  useEffect(() => {
    void getApp().then(async (app) => {
      if (!app.phone) return;
      const ctx = app.phone.context();
      if (amendId) {
        const v = await app.phone.repos.voucherRepo.findById(amendId, ctx);
        if (!v) return;
        const party = await app.phone.repos.partyRepo.findById(v.partyId, ctx);
        setOriginal({ version: v.version, amount: v.amount });
        setValues({
          party: { id: v.partyId, name: party?.name ?? "" },
          amount: v.amount,
          currency: v.currency ?? "USD",
          rate: v.currency === "USD" ? null : (v.exchangeRate ?? null),
          discount: v.discount ?? null,
          method: ((v.method as VoucherMethod | undefined) ?? "cash") as VoucherMethod,
          note: v.notesInternal ?? "",
        });
      } else if (partyId) {
        const party = await app.phone.repos.partyRepo.findById(partyId, ctx);
        if (party) setValues((x) => ({ ...x, party: { id: party.id, name: party.name } }));
      }
    });
  }, [amendId, partyId]);

  const save = async () => {
    setAttempted(true);
    if (voucherProblems(values).length > 0 || !values.party || !values.amount) return;
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const body = {
        date: localDateISO(new Date()),
        partyId: values.party.id,
        partyKind,
        amount: values.amount,
        currency: values.currency,
        exchangeRate: values.currency === "USD" ? 1 : (values.rate ?? 0),
        method: values.method,
        ...(values.discount ? { discount: values.discount } : {}),
        ...(values.note.trim() ? { notesInternal: values.note.trim() } : {}),
      };
      const result =
        amendId && original
          ? await app.phone.documents.replaceVoucher(amendId, kind, original.version, body)
          : await app.phone.documents.createVoucher(kind, body);
      if (!result.ok) return setError(result.error);
      await finish();
      setDone({ id: result.data.id, number: result.data.number });
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    }
  };

  if (done) {
    return (
      <DocumentDoneView
        title={kind === "receipt" ? "سند القبض" : "سند الصرف"}
        number={done.number}
        note={SAVED_LOCALLY_NOTE}
        shareSlot={<SharePdfButton docRef={{ type: "voucher", id: done.id }} variant="primary" />}
        onNew={() => {
          setDone(null);
          setAttempted(false);
          setValues(emptyVoucher());
          router.replace(`/(tabs)/add/${kind}` as never);
        }}
        newLabel={kind === "receipt" ? "سند قبض جديد" : "سند صرف جديد"}
      />
    );
  }

  return (
    <VoucherForm
      key={original ? `amend-${original.version}` : "new"}
      kind={kind}
      {...(amendId ? { amend: true } : {})}
      {...(original ? { initialAmount: String(original.amount) } : {})}
      values={values}
      balances={balances.data}
      error={error}
      attempted={attempted}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSave={save}
    />
  );
}
