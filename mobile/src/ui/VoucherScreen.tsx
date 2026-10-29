import { useEffect, useState } from "react";
import { router } from "expo-router";
import { getApp } from "../core/appRuntime";
import { useFinishWrite } from "../hooks/useFinishWrite";
import { Pressable, View } from "react-native";
import { SendToCustomer } from "./SendToCustomer";
import { Text } from "./Text";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { emptyVoucher, VoucherForm, type VoucherFormValues } from "./VoucherForm";
import { localDateISO } from "@backend/infrastructure/utils/localDate";

/** Receipt/payment screen. With `amendId` it loads the voucher and saves through the replace use-case in one call (FR-21). */
export function VoucherScreen({
  kind,
  amendId,
}: {
  kind: "receipt" | "payment";
  amendId?: string;
}) {
  const finish = useFinishWrite();
  const [values, setValues] = useState<VoucherFormValues>(emptyVoucher());
  const [original, setOriginal] = useState<{ version: number; amount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: string } | null>(null);

  useEffect(() => {
    if (!amendId) return;
    void getApp().then(async (app) => {
      if (!app.phone) return;
      const v = await app.phone.repos.voucherRepo.findById(amendId, app.phone.context());
      if (!v) return;
      const party = await app.phone.repos.partyRepo.findById(v.partyId, app.phone.context());
      setOriginal({ version: v.version, amount: v.amount });
      setValues({
        party: { id: v.partyId, name: party?.name ?? "" },
        amount: v.amount,
        currency: v.currency ?? "USD",
        rate: v.exchangeRate ?? 1,
        discount: v.discount ?? null,
        note: v.notesInternal ?? "",
      });
    });
  }, [amendId]);

  const save = async () => {
    if (!values.party || !values.amount || !values.rate) return;
    setBusy(true);
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const body = {
        date: localDateISO(new Date()),
        partyId: values.party.id,
        partyKind: kind === "receipt" ? ("customer" as const) : ("supplier" as const),
        amount: values.amount,
        currency: values.currency,
        exchangeRate: values.rate,
        method: "cash" as const,
        ...(values.discount ? { discount: values.discount } : {}),
        ...(values.note.trim() ? { notesInternal: values.note.trim() } : {}),
      };
      const result =
        amendId && original
          ? await app.phone.documents.replaceVoucher(amendId, kind, original.version, body)
          : await app.phone.documents.createVoucher(kind, body);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await finish();
      setDone({ id: result.data.id, number: result.data.number });
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <View style={{ flex: 1, padding: spacing.xl, paddingTop: 64, gap: spacing.md }}>
        <Text testID="voucher-done" style={{ fontSize: fontSize.title }}>
          {`تم حفظ السند ${done.number}`}
        </Text>
        <SendToCustomer docRef={{ type: "voucher", id: done.id }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="تم"
          onPress={() => router.back()}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text>تم</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <VoucherForm
      kind={kind}
      {...(amendId ? { amend: true } : {})}
      {...(original ? { initialAmount: String(original.amount) } : {})}
      values={values}
      error={error}
      busy={busy}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSave={() => void save()}
    />
  );
}
