// The return screen (FR-18): kind → party → source invoice → returned kg per line → reason, and the list of returns with
// cancel. One scrolling form; every figure of the valuation comes from the use-case after saving.
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import {
  RETURN_PROBLEM_TEXT,
  RETURN_REASON_LABEL,
  returnProblems,
  type ReturnDraft,
  type ReturnKind,
  type ReturnListRow,
  type ReturnReason,
  type SourceInvoiceRow,
} from "../core/returns";
import { MoneyInput } from "./MoneyInput";
import { MoneyText } from "./MoneyText";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress(): void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={{
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        paddingHorizontal: spacing.lg,
        borderRadius: radius.md,
        backgroundColor: selected ? colors.primary : colors.muted,
      }}
    >
      <Text style={{ color: selected ? colors.primaryForeground : colors.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ReturnFormView({
  draft,
  invoices,
  busy,
  error,
  onKind,
  onParty,
  onInvoice,
  onQty,
  onReason,
  onSave,
}: {
  draft: ReturnDraft;
  invoices: SourceInvoiceRow[];
  busy: boolean;
  error: string | null;
  onKind(k: ReturnKind): void;
  onParty(p: PickedParty): void;
  onInvoice(i: SourceInvoiceRow): void;
  onQty(rollId: string, patch: { kg?: number; pieces?: number }): void;
  onReason(r: ReturnReason): void;
  onSave(): void;
}) {
  const colors = useColors();
  const problems = returnProblems(draft);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 140 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>مرتجع جديد</Text>
        <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg }}>
          <Chip label="مرتجع بيع" selected={draft.kind === "sale"} onPress={() => onKind("sale")} />
          <Chip
            label="مرتجع شراء"
            selected={draft.kind === "entry"}
            onPress={() => onKind("entry")}
          />
        </View>
        <PartyPicker
          key={draft.kind}
          kind={draft.kind === "sale" ? "customer" : "supplier"}
          value={draft.party}
          onPick={onParty}
        />
        {draft.party ? (
          <View style={{ marginBottom: spacing.lg }}>
            <Text style={{ color: colors.mutedForeground, marginBottom: spacing.xs }}>
              الفاتورة الأصلية
            </Text>
            {invoices.length === 0 ? <Text testID="no-invoices">لا فواتير لهذا الطرف</Text> : null}
            {invoices.map((i) => (
              <Pressable
                key={i.id}
                testID="source-invoice"
                accessibilityRole="button"
                accessibilityLabel={`فاتورة ${i.number}`}
                accessibilityState={{ selected: draft.invoice?.id === i.id }}
                onPress={() => onInvoice(i)}
                style={{
                  minHeight: TOUCH_TARGET,
                  justifyContent: "center",
                  padding: spacing.md,
                  marginBottom: spacing.xs,
                  borderRadius: radius.md,
                  backgroundColor: draft.invoice?.id === i.id ? colors.primary : colors.card,
                }}
              >
                <Text
                  style={{
                    color:
                      draft.invoice?.id === i.id ? colors.primaryForeground : colors.foreground,
                  }}
                >{`${i.number} · ${i.date} · ${i.total} ${i.currency}`}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {draft.invoice
          ? draft.lines.map((l) => (
              <View
                key={l.rollId}
                testID="return-line"
                style={{
                  backgroundColor: colors.card,
                  borderRadius: radius.lg,
                  padding: spacing.lg,
                  marginBottom: spacing.md,
                }}
              >
                <Text>{l.label}</Text>
                <Text style={{ color: colors.mutedForeground }}>
                  {`المباع ${l.soldKg} كغ · السعر ${l.pricePerKg}`}
                </Text>
                <MoneyInput
                  label="الكمية المرتجعة (كغ)"
                  fieldId={`ret-kg-${l.rollId}`}
                  onChangeAmount={(v) => onQty(l.rollId, { kg: v ?? 0 })}
                />
                <MoneyInput
                  label="عدد الأثواب (يمكن 0)"
                  fieldId={`ret-pcs-${l.rollId}`}
                  onChangeAmount={(v) => onQty(l.rollId, { pieces: Math.round(v ?? 0) })}
                />
              </View>
            ))
          : null}
        <Text style={{ color: colors.mutedForeground, marginTop: spacing.md }}>السبب</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {(Object.keys(RETURN_REASON_LABEL) as ReturnReason[]).map((r) => (
            <Chip
              key={r}
              label={RETURN_REASON_LABEL[r]}
              selected={draft.reason === r}
              onPress={() => onReason(r)}
            />
          ))}
        </View>
        {problems.map((p) => (
          <Text key={p} style={{ color: colors.negative, marginTop: spacing.sm }}>
            {RETURN_PROBLEM_TEXT[p]}
          </Text>
        ))}
        {error ? (
          <Text testID="return-error" style={{ color: colors.negative, marginTop: spacing.md }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ المرتجع"}
        disabled={busy || problems.length > 0}
        onPress={onSave}
      />
    </View>
  );
}

export function ReturnListView({
  rows,
  canCancel,
  error,
  onCancel,
  sendSlot,
}: {
  rows: ReturnListRow[];
  canCancel: boolean;
  error: string | null;
  onCancel(row: ReturnListRow): void;
  sendSlot?(row: ReturnListRow): React.ReactNode;
}) {
  const colors = useColors();
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>المرتجعات</Text>
      {error ? (
        <Text testID="returns-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      {rows.length === 0 ? <Text testID="returns-empty">لا مرتجعات</Text> : null}
      {rows.map((r) => (
        <View
          key={r.id}
          testID="return-row"
          style={{
            backgroundColor: colors.card,
            borderRadius: radius.lg,
            padding: spacing.lg,
            marginBottom: spacing.sm,
          }}
        >
          <Text>{`${r.number} · ${r.kind === "sale" ? "بيع" : "شراء"} · ${r.date}`}</Text>
          <MoneyText amount={r.total} currency={r.currency} />
          {sendSlot ? sendSlot(r) : null}
          {r.status === "cancelled" ? (
            <Text style={{ color: colors.negative }}>ملغى</Text>
          ) : canCancel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`إلغاء المرتجع ${r.number}`}
              onPress={() => onCancel(r)}
              style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
            >
              <Text style={{ color: colors.negative }}>إلغاء المرتجع</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
