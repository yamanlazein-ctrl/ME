// The purchase (entry) steps: supplier → lines (a line may name a new fabric/colour, created with the invoice) → review, and
// the done screen (FR-16).
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import {
  ENTRY_PROBLEM_TEXT,
  entryProblems,
  entryTotals,
  type EntryDraft,
  type EntryDraftLine,
} from "../core/entryDraft";
import { CURRENCIES } from "./VoucherForm";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { MoneyText } from "./MoneyText";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

function Chip({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress(): void;
  selected?: boolean;
}) {
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

export function EntrySupplierView({
  draft,
  onSupplier,
  onCurrency,
  onRate,
  onNext,
}: {
  draft: EntryDraft;
  onSupplier(p: PickedParty): void;
  onCurrency(c: string): void;
  onRate(rate: number | null): void;
  onNext(): void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>١ — المورد</Text>
        <PartyPicker kind="supplier" value={draft.supplier} onPick={onSupplier} />
        <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg }}>
          {CURRENCIES.map((c) => (
            <Chip key={c} label={c} selected={draft.currency === c} onPress={() => onCurrency(c)} />
          ))}
        </View>
        <MoneyInput
          label="سعر الصرف (وحدات العملة لكل 1 دولار)"
          fieldId="entry-rate"
          onChangeAmount={onRate}
        />
      </ScrollView>
      <PrimaryActionBar
        label="التالي: البنود"
        disabled={!draft.supplier || !draft.exchangeRate}
        onPress={onNext}
      />
    </View>
  );
}

export interface LineFormValue {
  fabricId?: string;
  fabricName: string;
  colorId?: string;
  colorName: string;
  dyeBatch: string;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
}

/** The add-line form: type a fabric / colour or tap an existing one; new names are created when the invoice is saved. */
export function EntryLineForm({
  fabricSuggestions,
  colorSuggestions,
  onFabricQuery,
  onColorQuery,
  onSave,
  onCancel,
}: {
  fabricSuggestions: Array<{ id: string; name: string }>;
  colorSuggestions: Array<{ id: string; name: string }>;
  onFabricQuery(q: string, fabricId?: string): void;
  onColorQuery(q: string): void;
  onSave(line: LineFormValue): void;
  onCancel(): void;
}) {
  const [fabricName, setFabricName] = useState("");
  const [fabricId, setFabricId] = useState<string | undefined>();
  const [colorName, setColorName] = useState("");
  const [colorId, setColorId] = useState<string | undefined>();
  const [dyeBatch, setDyeBatch] = useState("");
  const [kg, setKg] = useState<number | null>(null);
  const [pieces, setPieces] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const valid =
    fabricName.trim().length > 0 && colorName.trim().length > 0 && (kg ?? 0) > 0 && price !== null;
  return (
    <View
      testID="entry-line-form"
      style={{
        backgroundColor: colors.background,
        padding: spacing.lg,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        maxHeight: "92%",
      }}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>بند جديد</Text>
        <Field
          label="القماش"
          fieldId="entry-fabric"
          value={fabricName}
          onChangeText={(t) => {
            setFabricName(t);
            setFabricId(undefined);
            setColorId(undefined);
            onFabricQuery(t);
          }}
        />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: spacing.sm,
            marginBottom: spacing.md,
          }}
        >
          {fabricSuggestions.slice(0, 5).map((f) => (
            <Chip
              key={f.id}
              label={f.name}
              onPress={() => {
                setFabricName(f.name);
                setFabricId(f.id);
                onFabricQuery(f.name, f.id);
              }}
            />
          ))}
        </View>
        <Field
          label="اللون"
          fieldId="entry-color"
          value={colorName}
          onChangeText={(t) => {
            setColorName(t);
            setColorId(undefined);
            onColorQuery(t);
          }}
        />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: spacing.sm,
            marginBottom: spacing.md,
          }}
        >
          {colorSuggestions.slice(0, 5).map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              onPress={() => {
                setColorName(c.name);
                setColorId(c.id);
              }}
            />
          ))}
        </View>
        <Field
          label="دفعة الصباغة (اختياري)"
          fieldId="entry-dye"
          value={dyeBatch}
          onChangeText={setDyeBatch}
        />
        <MoneyInput label="الكمية (كغ)" fieldId="entry-kg" onChangeAmount={setKg} />
        <MoneyInput
          label="عدد الأثواب"
          fieldId="entry-pieces"
          onChangeAmount={(v) => setPieces(v === null ? null : Math.round(v))}
        />
        <MoneyInput label="سعر الكيلو" fieldId="entry-price" onChangeAmount={setPrice} />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <Chip label="إلغاء" onPress={onCancel} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="حفظ البند"
            disabled={!valid}
            onPress={() =>
              onSave({
                ...(fabricId ? { fabricId } : {}),
                fabricName,
                ...(colorId ? { colorId } : {}),
                colorName,
                dyeBatch,
                quantityKg: kg ?? 0,
                pieces: pieces ?? 0,
                pricePerKg: price ?? 0,
              })
            }
            style={{
              flex: 1,
              minHeight: TOUCH_TARGET,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: radius.md,
              backgroundColor: valid ? colors.primary : colors.muted,
            }}
          >
            <Text style={{ color: valid ? colors.primaryForeground : colors.mutedForeground }}>
              حفظ البند
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

export function EntryLinesView({
  draft,
  adding,
  form,
  onAdd,
  onRemove,
  onNext,
}: {
  draft: EntryDraft;
  adding: boolean;
  form: React.ReactNode;
  onAdd(): void;
  onRemove(key: string): void;
  onNext(): void;
}) {
  const totals = entryTotals(draft);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>٢ — البنود</Text>
        {draft.lines.map((l: EntryDraftLine) => (
          <View
            key={l.key}
            testID="entry-line"
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              padding: spacing.lg,
              marginBottom: spacing.md,
            }}
          >
            <Text>{`${l.fabricName} · ${l.colorName}`}</Text>
            <Text style={{ color: colors.mutedForeground }}>
              {`${l.quantityKg} كغ × ${l.pricePerKg} · ${l.pieces} ثوب${l.fabricId && l.colorId ? "" : " · جديد"}`}
            </Text>
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
          onPress={onAdd}
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
      <Modal visible={adding} transparent animationType="slide" onRequestClose={() => undefined}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          {form}
        </View>
      </Modal>
    </View>
  );
}

export function EntryReviewView({
  draft,
  busy,
  error,
  onPatch,
  onSave,
}: {
  draft: EntryDraft;
  busy: boolean;
  error: string | null;
  onPatch(patch: Partial<EntryDraft>): void;
  onSave(): void;
}) {
  const totals = entryTotals(draft);
  const problems = entryProblems(draft);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>٣ — المراجعة</Text>
        <Text>{draft.supplier?.name ?? ""}</Text>
        <View testID="entry-total" style={{ marginVertical: spacing.md }}>
          <Text>الإجمالي</Text>
          <MoneyText amount={totals.total} currency={draft.currency} />
          <Text>المتبقي للمورد</Text>
          <MoneyText amount={totals.due} currency={draft.currency} />
        </View>
        <MoneyInput
          label="خصم الفاتورة (مبلغ ثابت)"
          fieldId="entry-discount"
          onChangeAmount={(v) => onPatch({ discount: v ?? 0 })}
        />
        <MoneyInput
          label="الضريبة"
          fieldId="entry-tax"
          onChangeAmount={(v) => onPatch({ tax: v ?? 0 })}
        />
        <MoneyInput
          label="الشحن"
          fieldId="entry-shipping"
          onChangeAmount={(v) => onPatch({ shipping: v ?? 0 })}
        />
        <MoneyInput
          label="المدفوع الآن"
          fieldId="entry-paid"
          onChangeAmount={(v) => onPatch({ paid: v ?? 0 })}
        />
        {problems.map((p) => (
          <Text key={p} style={{ color: colors.negative }}>
            {ENTRY_PROBLEM_TEXT[p]}
          </Text>
        ))}
        {error ? (
          <Text testID="entry-error" style={{ color: colors.negative }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ فاتورة الشراء"}
        disabled={busy || problems.length > 0}
        onPress={onSave}
      />
    </View>
  );
}

export function EntryDoneView({
  number,
  onOpen,
  onNew,
}: {
  number: string;
  onOpen(): void;
  onNew(): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.xl, paddingTop: 64, gap: spacing.md }}>
      <Text testID="entry-done-number" style={{ fontSize: fontSize.title }}>
        {`تم حفظ فاتورة الشراء ${number}`}
      </Text>
      <Chip label="عرض الفاتورة" onPress={onOpen} selected />
      <Chip label="فاتورة شراء جديدة" onPress={onNew} />
    </View>
  );
}
