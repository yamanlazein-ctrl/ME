// The sale invoice (FR-15, FR-17, FR-19) on one screen: customer, currency, lines, totals and payment, then save. Totals
// are the shared `invoiceTotal` (saleDraft.ts), the same function the use-case saves with; the draft survives leaving the
// screen and a refused save.
import { useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import {
  draftProblems,
  draftTotals,
  DRAFT_PROBLEM_TEXT,
  needsRate,
  type DraftLine,
  type SaleDraft,
} from "../core/saleDraft";
import type { PickableLot } from "../core/stock";
import { kg, money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { LotPickerSheet } from "./LotPicker";
import { useColors } from "./themeContext-core";
import {
  Button,
  Chips,
  EmptyState,
  KeyValue,
  ListRow,
  Notice,
  Screen,
  Section,
  Sheet,
} from "./kit";

export const CURRENCY_OPTIONS = [
  { value: "USD", label: "دولار USD" },
  { value: "SYP", label: "ليرة SYP" },
];

/** The line a picked lot starts as: 1 kg (or what is left) at the lot's sale price. */
export function lineFromLot(lot: PickableLot, key: string): DraftLine {
  return {
    key,
    fabricId: lot.fabricId,
    fabricName: lot.fabricName,
    colorId: lot.colorId,
    colorName: lot.colorName,
    rollId: lot.id,
    rollNo: lot.rollNo,
    rollCurrency: lot.currency,
    remainingKg: lot.remainingKg,
    quantityKg: Math.min(1, lot.remainingKg),
    pieces: 0,
    pricePerKg: lot.defaultPricePerKg,
    discountAmount: 0,
  };
}

function lineAmount(l: DraftLine): number {
  return Math.round((l.quantityKg * l.pricePerKg - l.discountAmount) * 100) / 100;
}

/** Edits one line in a sheet: kg (never above the lot), pieces, price, discount; or removes it. */
export function LineEditorSheet({
  line,
  currency,
  onChange,
  onRemove,
  onClose,
}: {
  line: DraftLine | null;
  currency: string;
  onChange(patch: Partial<DraftLine>): void;
  onRemove(): void;
  onClose(): void;
}) {
  if (!line) return null;
  const over = line.quantityKg > line.remainingKg;
  return (
    <Sheet
      visible
      title={`صبغة ${line.rollNo}`}
      onClose={onClose}
      testID="line-sheet"
      footer={
        <>
          <Button
            label="تم"
            onPress={onClose}
            disabled={over || !(line.quantityKg > 0)}
            testID="line-done"
          />
          <Button label="حذف البند" variant="danger" onPress={onRemove} testID="line-remove" />
        </>
      }
    >
      <Text>{`${line.fabricName} · ${line.colorName}`}</Text>
      <KeyValue label="المتوفر في الصبغة" value={kg(line.remainingKg)} />
      <MoneyInput
        label="الكمية (كغ)"
        fieldId="line-kg"
        initialText={String(line.quantityKg)}
        error={over ? "أكبر من المتوفر في الصبغة" : null}
        onChangeAmount={(v) => onChange({ quantityKg: v ?? 0 })}
      />
      <MoneyInput
        label="عدد الأثواب"
        fieldId="line-pieces"
        initialText={String(line.pieces)}
        onChangeAmount={(v) => onChange({ pieces: Math.max(0, Math.round(v ?? 0)) })}
      />
      <MoneyInput
        label={`سعر الكيلو (${currency})`}
        fieldId="line-price"
        initialText={String(line.pricePerKg)}
        onChangeAmount={(v) => onChange({ pricePerKg: v ?? 0 })}
      />
      <MoneyInput
        label="خصم على البند (مبلغ)"
        fieldId="line-discount"
        initialText={line.discountAmount ? String(line.discountAmount) : ""}
        onChangeAmount={(v) => onChange({ discountAmount: v ?? 0 })}
      />
      <KeyValue label="قيمة البند" value={money(lineAmount(line), currency)} strong />
    </Sheet>
  );
}

export interface SaleFormProps {
  draft: SaleDraft;
  error: string | null;
  onParty(p: PickedParty): void;
  onCurrency(c: string): void;
  onRate(rate: number | null): void;
  onAddLot(lot: PickableLot): void;
  onEditLine(key: string, patch: Partial<DraftLine>): void;
  onRemoveLine(key: string): void;
  onPatch(patch: Partial<SaleDraft>): void;
  onSave(): Promise<void>;
  onDiscard(): void;
}

export function SaleFormView(p: SaleFormProps) {
  const colors = useColors();
  const { draft } = p;
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [extras, setExtras] = useState(draft.discount > 0 || draft.tax > 0 || draft.shipping > 0);
  const totals = draftTotals(draft);
  const problems = draftProblems(draft);
  const show = (k: (typeof problems)[number]) => attempted && problems.includes(k);
  const editingLine = draft.lines.find((l) => l.key === editing) ?? null;
  return (
    <Screen
      title="فاتورة بيع"
      subtitle={draft.party?.name ?? "جديدة"}
      footerNotice={
        <>
          {attempted && problems.length > 0 ? (
            <Notice
              kind="error"
              text={problems.map((k) => DRAFT_PROBLEM_TEXT[k]).join("\n")}
              testID="sale-problems"
            />
          ) : null}
          {p.error ? <Notice kind="error" text={p.error} testID="sale-error" /> : null}
        </>
      }
      footer={
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: colors.mutedForeground }}>الإجمالي</Text>
            <Text testID="sale-total" style={{ fontWeight: "700", writingDirection: "ltr" }}>
              {money(totals.total, draft.currency)}
            </Text>
          </View>
          <Button
            label="حفظ الفاتورة"
            busyLabel="جارٍ الحفظ…"
            testID="sale-save"
            onPress={async () => {
              setAttempted(true);
              if (problems.length === 0) await p.onSave();
            }}
          />
        </>
      }
    >
      <Section title="العميل والعملة">
        <PartyPicker
          kind="customer"
          value={draft.party}
          onPick={p.onParty}
          error={show("no-party")}
        />
        <Chips
          options={CURRENCY_OPTIONS}
          value={draft.currency}
          onChange={p.onCurrency}
          testIDPrefix="sale-currency"
        />
        {needsRate(draft) ? (
          <MoneyInput
            label="سعر الصرف (ليرة لكل 1 دولار)"
            fieldId="sale-rate"
            initialText={draft.exchangeRate ? String(draft.exchangeRate) : ""}
            error={
              show("no-rate")
                ? "سعر الصرف مطلوب"
                : show("bad-rate")
                  ? DRAFT_PROBLEM_TEXT["bad-rate"]
                  : null
            }
            onChangeAmount={p.onRate}
          />
        ) : null}
      </Section>

      <Section
        title={`البنود (${draft.lines.length})`}
        padded={false}
        action={
          <Button
            label="إضافة بند"
            variant="ghost"
            icon="add"
            block={false}
            onPress={() => setPicking(true)}
            testID="add-line"
          />
        }
      >
        {draft.lines.length === 0 ? (
          <EmptyState
            icon="cube-outline"
            title="لا بنود بعد"
            hint="اختر صبغة من المخزون ثم اكتب الكمية والسعر."
            action={{ label: "إضافة بند", onPress: () => setPicking(true) }}
          />
        ) : (
          draft.lines.map((l, i) => (
            <ListRow
              key={l.key}
              testID={`line-${l.rollNo}`}
              accessibilityLabel={`بند ${l.rollNo}`}
              title={`${l.fabricName} · ${l.colorName}`}
              subtitle={`صبغة ${l.rollNo} · ${kg(l.quantityKg)} × ${money(l.pricePerKg, draft.currency)}`}
              meta={
                l.quantityKg > l.remainingKg
                  ? `أكبر من المتوفر (${kg(l.remainingKg)})`
                  : l.discountAmount
                    ? `خصم ${money(l.discountAmount, draft.currency)}`
                    : null
              }
              value={money(lineAmount(l), draft.currency)}
              onPress={() => setEditing(l.key)}
              last={i === draft.lines.length - 1}
            />
          ))
        )}
      </Section>
      {show("no-lines") ? <Notice kind="error" text={DRAFT_PROBLEM_TEXT["no-lines"]} /> : null}

      <Section title="الإجمالي والدفع" testID="sale-totals">
        <KeyValue label="مجموع البنود" value={money(totals.subtotal, draft.currency)} />
        {extras ? (
          <>
            <MoneyInput
              label="خصم على الفاتورة (مبلغ)"
              fieldId="sale-discount"
              initialText={draft.discount ? String(draft.discount) : ""}
              onChangeAmount={(v) => p.onPatch({ discount: v ?? 0 })}
            />
            <MoneyInput
              label="الضريبة (مبلغ)"
              fieldId="sale-tax"
              initialText={draft.tax ? String(draft.tax) : ""}
              onChangeAmount={(v) => p.onPatch({ tax: v ?? 0 })}
            />
            <MoneyInput
              label="الشحن (مبلغ)"
              fieldId="sale-shipping"
              initialText={draft.shipping ? String(draft.shipping) : ""}
              onChangeAmount={(v) => p.onPatch({ shipping: v ?? 0 })}
            />
          </>
        ) : (
          <Button
            label="خصم أو ضريبة أو شحن"
            variant="ghost"
            icon="add"
            block={false}
            onPress={() => setExtras(true)}
          />
        )}
        <KeyValue label="الإجمالي" value={money(totals.total, draft.currency)} strong />
        <MoneyInput
          label="المدفوع الآن (نقداً)"
          fieldId="sale-paid"
          initialText={draft.paid ? String(draft.paid) : ""}
          onChangeAmount={(v) => p.onPatch({ paid: v ?? 0 })}
        />
        <KeyValue
          label="المتبقي على العميل"
          value={money(totals.due, draft.currency)}
          strong
          tone={totals.due > 0 ? "warning" : "positive"}
          testID="sale-due"
        />
        {draft.paid > totals.total && totals.total > 0 ? (
          <Notice kind="info" text="الزائد عن الإجمالي يُسجَّل رصيداً لصالح العميل." />
        ) : null}
      </Section>

      {draft.party || draft.lines.length > 0 ? (
        <Button label="مسح المسودة" variant="ghost" onPress={p.onDiscard} testID="sale-discard" />
      ) : null}

      <LotPickerSheet
        visible={picking}
        exclude={draft.lines.map((l) => l.rollId)}
        onClose={() => setPicking(false)}
        onPick={(lot) => {
          setPicking(false);
          p.onAddLot(lot);
        }}
      />
      <LineEditorSheet
        key={editingLine?.key ?? "none"}
        line={editingLine}
        currency={draft.currency}
        onChange={(patch) => editingLine && p.onEditLine(editingLine.key, patch)}
        onRemove={() => {
          if (editingLine) p.onRemoveLine(editingLine.key);
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
    </Screen>
  );
}

/** After a save: the number, and what to do next with the document. */
export function DocumentDoneView({
  title,
  number,
  note,
  onOpen,
  onNew,
  newLabel,
  shareSlot,
}: {
  title: string;
  number: string;
  note?: string;
  onOpen?: () => void;
  onNew(): void;
  newLabel: string;
  shareSlot?: React.ReactNode;
}) {
  return (
    <Screen title={title} back={false}>
      <Notice kind="success" text={`تم حفظ ${title} رقم ${number} على الهاتف.`} testID="doc-done" />
      <Text
        testID="sale-done-number"
        style={{ textAlign: "center", fontSize: 24, fontWeight: "700" }}
      >
        {number}
      </Text>
      {note ? <Notice kind="info" text={note} /> : null}
      {shareSlot}
      {onOpen ? (
        <Button
          label="عرض المستند"
          variant="secondary"
          icon="document-text-outline"
          onPress={onOpen}
        />
      ) : null}
      <Button label={newLabel} icon="add" onPress={onNew} testID="doc-new" />
    </Screen>
  );
}

/** Saved on the phone; the sync chip says when the hub has it. */
export const SAVED_LOCALLY_NOTE =
  "يُرسل إلى المركز تلقائياً عند توفر الاتصال — راقب مؤشر المزامنة أعلى الشاشة.";
