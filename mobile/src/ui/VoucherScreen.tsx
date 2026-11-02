import { useEffect, useState } from "react";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../core/appRuntime";
import type { Phone } from "../core/phone";
import { loadOpenInvoices, partyBalances } from "../core/parties";
import { queryKeys } from "../hooks/queryKeys";
import { useFinishWrite } from "../hooks/useFinishWrite";
import { SharePdfButton } from "./SendToCustomer";
import { DocumentDoneView, SAVED_LOCALLY_NOTE } from "./SaleViews";
import {
  emptyVoucher,
  VoucherForm,
  voucherNeedsRate,
  voucherProblems,
  type OpenInvoice,
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
  invoiceId,
}: {
  kind: "receipt" | "payment";
  amendId?: string;
  partyId?: string;
  /** Opened from an invoice: that invoice is the linked one. */
  invoiceId?: string;
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

  // The party's unpaid invoices of this direction (sale for a receipt, purchase for a payment).
  const openInvoices = useQuery({
    queryKey: [...queryKeys.party(values.party?.id ?? ""), "open-invoices", kind],
    enabled: Boolean(values.party),
    queryFn: async (): Promise<OpenInvoice[]> => {
      const app = await getApp();
      if (!app.phone || !values.party) return [];
      return loadOpenInvoices(app.phone, values.party.id, kind);
    },
  });

  useEffect(() => {
    void getApp()
      .then(async (app) => {
        if (!app.phone) return;
        const ctx = app.phone.context();
        if (amendId) {
          const v = await app.phone.repos.voucherRepo.findById(amendId, ctx);
          if (!v) {
            setError("هذا السند غير موجود على الهاتف، فلا يمكن تعديله.");
            return;
          }
          const party = await app.phone.repos.partyRepo.findById(v.partyId, ctx);
          setOriginal({ version: v.version, amount: v.amount });
          setValues({
            party: { id: v.partyId, name: party?.name ?? "" },
            amount: v.amount,
            currency: v.currency ?? "USD",
            // Kept whenever one was stored (a USD voucher on a SYP invoice has one too).
            rate: v.exchangeRate && Number(v.exchangeRate) !== 1 ? Number(v.exchangeRate) : null,
            discount: v.discount ?? null,
            method: ((v.method as VoucherMethod | undefined) ?? "cash") as VoucherMethod,
            note: v.notesInternal ?? "",
            notePrint: v.notesPrint ?? "",
            date: String(v.date).slice(0, 10),
            invoice: await amendedInvoice(app.phone, v, kind),
          });
        } else if (partyId) {
          const party = await app.phone.repos.partyRepo.findById(partyId, ctx);
          if (!party) return;
          const linked = invoiceId
            ? ((await loadOpenInvoices(app.phone, party.id, kind)).find(
                (i) => i.id === invoiceId,
              ) ?? null)
            : null;
          setValues((x) => ({
            ...x,
            party: { id: party.id, name: party.name },
            ...(linked ? { invoice: linked, currency: linked.currency } : {}),
          }));
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "تعذّر تحميل السند"));
  }, [amendId, partyId, invoiceId, kind]);

  const save = async () => {
    setAttempted(true);
    if (voucherProblems(values, kind).length > 0 || !values.party || !values.amount) return;
    // Amending a voucher that never loaded must not silently create a new one (UI audit P11).
    if (amendId && !original) return setError("هذا السند غير موجود على الهاتف، فلا يمكن تعديله.");
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const body = {
        date: values.date || localDateISO(new Date()),
        partyId: values.party.id,
        ...(values.invoice ? { invoiceId: values.invoice.id } : {}),
        partyKind,
        amount: values.amount,
        currency: values.currency,
        // Only a voucher that needs a rate carries one (a rate typed before switching back to USD is dropped).
        exchangeRate: voucherNeedsRate(values) ? (values.rate ?? 0) : 1,
        method: values.method,
        ...(values.discount ? { discount: values.discount } : {}),
        ...(values.note.trim() ? { notesInternal: values.note.trim() } : {}),
        ...(values.notePrint.trim() ? { notesPrint: values.notePrint.trim() } : {}),
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
      {...(openInvoices.data ? { openInvoices: openInvoices.data } : {})}
      today={localDateISO(new Date())}
      error={error}
      attempted={attempted}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSave={save}
    />
  );
}

/**
 * The invoice an amended voucher is tied to, with that voucher's own settlement added back to what is left: the amend
 * replaces it, so it must not count against itself (the desktop's credit-back).
 */
async function amendedInvoice(
  phone: Phone,
  v: { invoiceId?: string | null; partyId: string; appliedAmount?: number | string | null },
  kind: "receipt" | "payment",
): Promise<OpenInvoice | null> {
  if (!v.invoiceId) return null;
  const inv = (await loadOpenInvoices(phone, v.partyId, kind, true)).find(
    (i) => i.id === v.invoiceId,
  );
  if (!inv) return null;
  return {
    ...inv,
    remaining: Math.round((inv.remaining + (Number(v.appliedAmount) || 0)) * 100) / 100,
  };
}
