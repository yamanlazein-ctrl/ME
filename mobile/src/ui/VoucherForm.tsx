// Receipt / payment form (FR-20, FR-21): party → amount + currency + rate (typed by the user, never pre-filled from the
// reference rate: fx.route.ts) + optional discount → save. Refusals from the use-case (insufficient cash, locked day or
// closed year) are shown as the use-case wrote them (E10, E11).
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, radius, spacing, TOUCH_TARGET } from "./theme";

export const CURRENCIES = ["USD", "SYP"] as const;

export interface VoucherFormValues {
  party: PickedParty | null;
  amount: number | null;
  currency: string;
  rate: number | null;
  discount: number | null;
  note: string;
}

export function emptyVoucher(): VoucherFormValues {
  return { party: null, amount: null, currency: "USD", rate: 1, discount: null, note: "" };
}

export function VoucherForm({
  kind,
  amend,
  values,
  error,
  busy,
  initialAmount,
  onChange,
  onSave,
}: {
  kind: "receipt" | "payment";
  amend?: boolean;
  values: VoucherFormValues;
  error: string | null;
  busy: boolean;
  initialAmount?: string;
  onChange(patch: Partial<VoucherFormValues>): void;
  onSave(): void;
}) {
  const partyKind = kind === "receipt" ? "customer" : "supplier";
  const ready = Boolean(
    values.party && values.amount && values.amount > 0 && values.rate && values.rate > 0,
  );
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <PartyPicker
          kind={partyKind}
          value={values.party}
          onPick={(party) => onChange({ party })}
        />
        <MoneyInput
          label="المبلغ"
          fieldId="voucher-amount"
          initialText={initialAmount ?? ""}
          onChangeAmount={(amount) => onChange({ amount })}
        />
        <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg }}>
          {CURRENCIES.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityLabel={c}
              accessibilityState={{ selected: values.currency === c }}
              onPress={() => onChange({ currency: c })}
              style={{
                minHeight: TOUCH_TARGET,
                justifyContent: "center",
                paddingHorizontal: spacing.xl,
                borderRadius: radius.md,
                backgroundColor: values.currency === c ? colors.primary : colors.muted,
              }}
            >
              <Text
                style={{
                  color: values.currency === c ? colors.primaryForeground : colors.foreground,
                }}
              >
                {c}
              </Text>
            </Pressable>
          ))}
        </View>
        <MoneyInput
          label="سعر الصرف (وحدات العملة لكل 1 دولار)"
          fieldId="voucher-rate"
          initialText="1"
          onChangeAmount={(rate) => onChange({ rate })}
        />
        <MoneyInput
          label="خصم (اختياري)"
          fieldId="voucher-discount"
          onChangeAmount={(discount) => onChange({ discount })}
        />
        <Field
          label="ملاحظة (اختياري)"
          fieldId="voucher-note"
          value={values.note}
          onChangeText={(note) => onChange({ note })}
        />
        {error ? (
          <Text testID="voucher-error" style={{ color: colors.negative }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={
          busy
            ? "جارٍ الحفظ…"
            : amend
              ? "حفظ التعديل"
              : kind === "receipt"
                ? "حفظ سند القبض"
                : "حفظ سند الدفع"
        }
        disabled={busy || !ready}
        onPress={onSave}
      />
    </View>
  );
}
