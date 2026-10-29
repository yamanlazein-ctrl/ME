// The three sale steps (customer → lines → review) and the done screen (FR-15, FR-17, FR-19).
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import {
  draftProblems,
  draftTotals,
  DRAFT_PROBLEM_TEXT,
  type DraftLine,
  type SaleDraft,
} from "../core/saleDraft";
import { CURRENCIES } from "./VoucherForm";
import { MoneyInput } from "./MoneyInput";
import { MoneyText } from "./MoneyText";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

function CurrencyToggle({ value, onChange }: { value: string; onChange(c: string): void }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg }}>
      {CURRENCIES.map((c) => (
        <Pressable
          key={c}
          accessibilityRole="button"
          accessibilityLabel={c}
          accessibilityState={{ selected: value === c }}
          onPress={() => onChange(c)}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            paddingHorizontal: spacing.xl,
            borderRadius: radius.md,
            backgroundColor: value === c ? colors.primary : colors.muted,
          }}
        >
          <Text style={{ color: value === c ? colors.primaryForeground : colors.foreground }}>
            {c}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SaleCustomerView({
  draft,
  onParty,
  onCurrency,
  onRate,
  onNext,
}: {
  draft: SaleDraft;
  onParty(p: PickedParty): void;
  onCurrency(c: string): void;
  onRate(rate: number | null): void;
  onNext(): void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>١ — العميل</Text>
        <PartyPicker kind="customer" value={draft.party} onPick={onParty} />
        <CurrencyToggle value={draft.currency} onChange={onCurrency} />
        <MoneyInput
          label="سعر الصرف (وحدات العملة لكل 1 دولار)"
          fieldId="sale-rate"
          onChangeAmount={onRate}
        />
      </ScrollView>
      <PrimaryActionBar
        label="التالي: البنود"
        disabled={!draft.party || !draft.exchangeRate}
        onPress={onNext}
      />
    </View>
  );
}

export function SaleLinesView({
  draft,
  onAddLine,
  onRemove,
  onEdit,
  onNext,
}: {
  draft: SaleDraft;
  onAddLine(): void;
  onRemove(key: string): void;
  onEdit(key: string, patch: Partial<DraftLine>): void;
  onNext(): void;
}) {
  const totals = draftTotals(draft);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>٢ — البنود</Text>
        {draft.lines.map((l) => (
          <View
            key={l.key}
            testID={`line-${l.key}`}
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              padding: spacing.lg,
              marginBottom: spacing.md,
            }}
          >
            <Text>{`${l.fabricName} · ${l.colorName} · ${l.rollNo}`}</Text>
            <Text style={{ color: colors.mutedForeground }}>{`المتبقي ${l.remainingKg} كغ`}</Text>
            <MoneyInput
              label="الكمية (كغ)"
              fieldId={`kg-${l.key}`}
              initialText={String(l.quantityKg)}
              onChangeAmount={(v) => onEdit(l.key, { quantityKg: v ?? 0 })}
            />
            <MoneyInput
              label="عدد الأثواب"
              fieldId={`pcs-${l.key}`}
              initialText={String(l.pieces)}
              onChangeAmount={(v) => onEdit(l.key, { pieces: Math.round(v ?? 0) })}
            />
            <MoneyInput
              label="السعر للكيلو"
              fieldId={`price-${l.key}`}
              initialText={String(l.pricePerKg)}
              onChangeAmount={(v) => onEdit(l.key, { pricePerKg: v ?? 0 })}
            />
            <MoneyInput
              label="خصم البند (مبلغ ثابت)"
              fieldId={`disc-${l.key}`}
              onChangeAmount={(v) => onEdit(l.key, { discountAmount: v ?? 0 })}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="حذف البند"
              onPress={() => onRemove(l.key)}
              style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
            >
              <Text style={{ color: colors.negative }}>حذف البند</Text>
            </Pressable>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="إضافة بند"
          onPress={onAddLine}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
          }}
        >
          <Text>إضافة بند</Text>
        </Pressable>
        <View style={{ marginTop: spacing.lg }}>
          <Text>المجموع الفرعي</Text>
          <MoneyText amount={totals.subtotal} currency={draft.currency} />
        </View>
      </ScrollView>
      <PrimaryActionBar
        label="التالي: المراجعة"
        disabled={draft.lines.length === 0}
        onPress={onNext}
      />
    </View>
  );
}

export function SaleReviewView({
  draft,
  busy,
  error,
  onPatch,
  onSave,
}: {
  draft: SaleDraft;
  busy: boolean;
  error: string | null;
  onPatch(patch: Partial<SaleDraft>): void;
  onSave(): void;
}) {
  const totals = draftTotals(draft);
  const problems = draftProblems(draft);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>٣ — المراجعة</Text>
        <Text>{draft.party?.name ?? ""}</Text>
        <View testID="sale-total" style={{ marginVertical: spacing.md }}>
          <Text>الإجمالي</Text>
          <MoneyText amount={totals.total} currency={draft.currency} />
          <Text>المتبقي على العميل</Text>
          <MoneyText amount={totals.due} currency={draft.currency} />
        </View>
        <MoneyInput
          label="خصم الفاتورة (مبلغ ثابت)"
          fieldId="sale-discount"
          onChangeAmount={(v) => onPatch({ discount: v ?? 0 })}
        />
        <MoneyInput
          label="الضريبة"
          fieldId="sale-tax"
          onChangeAmount={(v) => onPatch({ tax: v ?? 0 })}
        />
        <MoneyInput
          label="الشحن"
          fieldId="sale-shipping"
          onChangeAmount={(v) => onPatch({ shipping: v ?? 0 })}
        />
        <MoneyInput
          label="المدفوع الآن"
          fieldId="sale-paid"
          onChangeAmount={(v) => onPatch({ paid: v ?? 0 })}
        />
        {problems.map((p) => (
          <Text key={p} style={{ color: colors.negative }}>
            {DRAFT_PROBLEM_TEXT[p]}
          </Text>
        ))}
        {error ? (
          <Text testID="sale-error" style={{ color: colors.negative }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ الفاتورة"}
        disabled={busy || problems.length > 0}
        onPress={onSave}
      />
    </View>
  );
}

export function SaleDoneView({
  number,
  onSharePdf,
  onNew,
  onOpen,
  sendSlot,
}: {
  number: string;
  onSharePdf(): void;
  onNew(): void;
  onOpen(): void;
  /** The "send to customer" control (it needs the device APIs, so the screen provides it). */
  sendSlot?: React.ReactNode;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.xl, paddingTop: 64, gap: spacing.md }}>
      <Text
        testID="sale-done-number"
        style={{ fontSize: fontSize.title }}
      >{`تم حفظ الفاتورة ${number}`}</Text>
      {[
        { label: "مشاركة PDF", onPress: onSharePdf },
        { label: "عرض الفاتورة", onPress: onOpen },
        { label: "فاتورة جديدة", onPress: onNew },
      ].map((a) => (
        <Pressable
          key={a.label}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          onPress={a.onPress}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            paddingHorizontal: spacing.xl,
            backgroundColor: colors.primary,
            borderRadius: radius.md,
          }}
        >
          <Text style={{ color: colors.primaryForeground }}>{a.label}</Text>
        </Pressable>
      ))}
      {sendSlot}
    </View>
  );
}
