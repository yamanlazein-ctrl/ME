// The purchase (entry) invoice (FR-16), with the desktop purchase form's fields and order: the invoice page (supplier,
// the supplier's invoice number, date, currency, rate, lines, totals, payment) and a full-page line editor whose
// sections follow the desktop's line card (القماش، الإنتاج، اللون، الوزن، الصباغة، الشراء) plus the lot's width,
// grammage and sale price. New fabrics, colours and the dye lots are created with the invoice in one save
// (documents.createEntryInvoice); the production details go into the line note the desktop's way (core/lineNote.ts).
import { useRef, useState, type ComponentRef } from "react";
import { TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Text } from "./Text";
import { getApp } from "../core/appRuntime";
import { pickColors, pickFabrics } from "../core/inventoryPicker";
import { lastEntryPrice } from "../core/stock";
import {
  ENTRY_PROBLEM_TEXT,
  LINE_PROBLEM_TEXT,
  entryLineTotal,
  entryProblems,
  entryTotals,
  lineProblems,
  type EntryDraft,
  type EntryDraftLine,
} from "../core/entryDraft";
import type { EntryLineInput } from "../core/documents";
import { queryKeys } from "../hooks/queryKeys";
import { Field } from "./Field";
import { kg, money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { CURRENCY_OPTIONS, PAYMENT_OPTIONS } from "./options";
import { spacing } from "./theme";
import { useColors } from "./themeContext-core";
import {
  Badge,
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

export { PAYMENT_OPTIONS };

async function phone() {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  return app.phone;
}

/** Names typed so far → existing matches; tapping one links the line to it, otherwise the name is created on save. */
function Suggestions({
  rows,
  onChoose,
}: {
  rows: Array<{ id: string; name: string }>;
  onChoose(row: { id: string; name: string }): void;
}) {
  if (rows.length === 0) return null;
  return (
    <Chips
      options={rows.slice(0, 8).map((r) => ({ value: r.id, label: r.name }))}
      value=""
      onChange={(id) => {
        const row = rows.find((r) => r.id === id);
        if (row) onChoose(row);
      }}
      testIDPrefix="suggest"
    />
  );
}

/** Two inputs side by side (short numbers), so a section fits the screen above the keyboard. */
function Pair({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: spacing.sm }}>{children}</View>;
}
function Half({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}

const num = (v: number | null | undefined): string => (v ? String(v) : "");

/** The purchase line's fields in the desktop line card's order. */
export const LINE_FIELD_ORDER = [
  "entry-fabric",
  "entry-reference",
  "entry-source",
  "entry-pieces",
  "entry-machine",
  "entry-kromaj",
  "entry-draw",
  "entry-color",
  "entry-color-code",
  "entry-gross",
  "entry-kg",
  "entry-dye",
  "entry-price",
  "entry-line-discount",
  "entry-width",
  "entry-gsm",
  "entry-sale-price",
];

/** One purchase line, a full page with the desktop's sections. `initial` pre-fills it (edit, or copy the last line). */
export function EntryLineView({
  currency,
  initial,
  editing,
  onSave,
  onCancel,
}: {
  currency: string;
  initial?: Partial<EntryLineInput>;
  editing: boolean;
  /** `next`: keep the page open for another line of the same fabric and colour. */
  onSave(line: EntryLineInput, next: boolean): void;
  onCancel(): void;
}) {
  const colors = useColors();
  const d = initial?.details ?? {};
  const [fabricName, setFabricName] = useState(initial?.fabricName ?? "");
  const [fabricId, setFabricId] = useState<string | undefined>(initial?.fabricId);
  const [reference, setReference] = useState(d.reference ?? "");
  const [source, setSource] = useState(d.source ?? "");
  const [pieces, setPieces] = useState<number | null>(initial?.pieces || null);
  const [machineNo, setMachineNo] = useState(d.machineNo ?? "");
  const [kromaj, setKromaj] = useState(d.kromaj ?? "");
  const [draw, setDraw] = useState(d.draw ?? "");
  const [colorName, setColorName] = useState(initial?.colorName ?? "");
  const [colorId, setColorId] = useState<string | undefined>(initial?.colorId);
  const [colorCode, setColorCode] = useState(initial?.colorCode ?? "");
  const [grossKg, setGrossKg] = useState<number | null>(d.grossKg ?? null);
  const [qty, setQty] = useState<number | null>(initial?.quantityKg || null);
  const [dyeBatch, setDyeBatch] = useState(initial?.dyeBatch ?? "");
  const [price, setPrice] = useState<number | null>(initial?.pricePerKg || null);
  const [priceKey, setPriceKey] = useState(0);
  const [discount, setDiscount] = useState<number | null>(initial?.discountAmount || null);
  const [widthCm, setWidthCm] = useState<number | null>(initial?.widthCm ?? null);
  const [weightGsm, setWeightGsm] = useState<number | null>(initial?.weightGsm ?? null);
  const [salePrice, setSalePrice] = useState<number | null>(initial?.salePricePerKg ?? null);
  const [specs, setSpecs] = useState(Boolean(initial?.widthCm || initial?.weightGsm));
  const [attempted, setAttempted] = useState(false);
  // «التالي» on the keyboard moves to the next field in the desktop's order (fast entry without scrolling); hidden
  // fields (the colour code of an existing colour, the collapsed specs) are skipped.
  const inputs = useRef<Record<string, ComponentRef<typeof TextInput> | null>>({});
  const chain = (id: string) => {
    const at = LINE_FIELD_ORDER.indexOf(id);
    const next = () =>
      LINE_FIELD_ORDER.slice(at + 1)
        .map((n) => inputs.current[n])
        .find((input) => input != null);
    return {
      inputRef: (node: ComponentRef<typeof TextInput> | null) => {
        inputs.current[id] = node;
      },
      returnKeyType: "next" as const,
      submitBehavior: "submit" as const,
      onSubmitEditing: () => next()?.focus(),
    };
  };

  const fabrics = useQuery({
    queryKey: [...queryKeys.inventory, "entry-fabrics", fabricName.trim()],
    enabled: fabricName.trim().length > 0 && !fabricId,
    queryFn: async () => pickFabrics(await phone(), fabricName.trim()),
  });
  const colorsOf = useQuery({
    queryKey: [...queryKeys.inventory, "entry-colors", fabricId ?? ""],
    enabled: Boolean(fabricId),
    queryFn: async () => pickColors(await phone(), fabricId!),
  });
  const last = useQuery({
    queryKey: [...queryKeys.inventory, "entry-last-price", fabricId ?? "", colorId ?? "", currency],
    enabled: Boolean(fabricId),
    queryFn: async () =>
      lastEntryPrice(await phone(), colorId ? { colorId } : { fabricId: fabricId! }, currency),
  });
  const colorMatches = (colorsOf.data ?? []).filter((c) => c.name.includes(colorName.trim()));

  const line: EntryLineInput = {
    ...(fabricId ? { fabricId } : {}),
    fabricName: fabricName.trim(),
    ...(colorId ? { colorId } : {}),
    colorName: colorName.trim(),
    ...(!colorId && colorCode.trim() ? { colorCode: colorCode.trim() } : {}),
    ...(dyeBatch.trim() ? { dyeBatch: dyeBatch.trim() } : {}),
    quantityKg: qty ?? 0,
    pieces: pieces ?? 0,
    pricePerKg: price ?? 0,
    ...(discount ? { discountAmount: discount } : {}),
    details: {
      reference,
      source,
      machineNo,
      kromaj,
      draw,
      grossKg,
    },
    ...(widthCm ? { widthCm } : {}),
    ...(weightGsm ? { weightGsm } : {}),
    ...(salePrice ? { salePricePerKg: salePrice } : {}),
  };
  const problems = lineProblems(line);
  const save = (next: boolean) => {
    setAttempted(true);
    if (problems.length === 0) onSave(line, next);
  };

  return (
    <Screen
      title={editing ? "تعديل البند" : "بند جديد"}
      subtitle={fabricName.trim() ? `${fabricName.trim()} · ${colorName.trim()}` : "فاتورة دخول"}
      onBack={onCancel}
      testID="entry-line-form"
      footerNotice={
        <>
          {attempted && problems.length > 0 ? (
            <Notice
              kind="error"
              text={problems.map((p) => LINE_PROBLEM_TEXT[p]).join("\n")}
              testID="entry-line-problems"
            />
          ) : null}
          <KeyValue
            label="الإجمالي"
            strong
            value={money(entryLineTotal(line), currency)}
            testID="entry-line-total"
          />
        </>
      }
      footer={
        <Pair>
          {editing ? null : (
            <Half>
              <Button
                label="حفظ وبند جديد"
                variant="secondary"
                testID="entry-line-save-next"
                onPress={() => save(true)}
              />
            </Half>
          )}
          <Half>
            <Button label="حفظ البند" testID="entry-line-save" onPress={() => save(false)} />
          </Half>
        </Pair>
      }
    >
      <Section title="بيانات القماش">
        <Field
          label="نوع القماش *"
          fieldId="entry-fabric"
          {...chain("entry-fabric")}
          value={fabricName}
          placeholder="اكتب الاسم لتظهر الأقمشة الموجودة"
          onChangeText={(t) => {
            setFabricName(t);
            setFabricId(undefined);
            setColorId(undefined);
          }}
        />
        {!fabricId ? (
          <Suggestions
            rows={fabrics.data ?? []}
            onChoose={(f) => {
              setFabricName(f.name);
              setFabricId(f.id);
            }}
          />
        ) : null}
        {fabricName.trim() ? (
          <Badge
            label={fabricId ? "قماش موجود" : "قماش جديد — يُنشأ مع الفاتورة"}
            tone={fabricId ? "positive" : "warning"}
          />
        ) : null}
        <Pair>
          <Half>
            <Field
              label="المرجعية"
              fieldId="entry-reference"
              {...chain("entry-reference")}
              value={reference}
              onChangeText={setReference}
            />
          </Half>
          <Half>
            <Field
              label="المصدر"
              fieldId="entry-source"
              {...chain("entry-source")}
              value={source}
              onChangeText={setSource}
            />
          </Half>
        </Pair>
      </Section>

      <Section title="بيانات الإنتاج">
        <Pair>
          <Half>
            <MoneyInput
              label="الأثواب"
              fieldId="entry-pieces"
              {...chain("entry-pieces")}
              initialText={num(initial?.pieces)}
              onChangeAmount={(v) => setPieces(v === null ? null : Math.round(v))}
            />
          </Half>
          <Half>
            <Field
              label="رقم الماكينة"
              fieldId="entry-machine"
              {...chain("entry-machine")}
              value={machineNo}
              onChangeText={setMachineNo}
            />
          </Half>
        </Pair>
        <Pair>
          <Half>
            <Field
              label="كراماج"
              fieldId="entry-kromaj"
              {...chain("entry-kromaj")}
              value={kromaj}
              keyboardType="numbers-and-punctuation"
              onChangeText={setKromaj}
            />
          </Half>
          <Half>
            <Field
              label="السحب"
              fieldId="entry-draw"
              {...chain("entry-draw")}
              value={draw}
              onChangeText={setDraw}
            />
          </Half>
        </Pair>
      </Section>

      <Section title="بيانات اللون">
        <Field
          label="اسم اللون *"
          fieldId="entry-color"
          {...chain("entry-color")}
          value={colorName}
          onChangeText={(t) => {
            setColorName(t);
            setColorId(undefined);
          }}
        />
        {fabricId && !colorId ? (
          <Suggestions
            rows={colorMatches}
            onChoose={(c) => {
              setColorName(c.name);
              setColorId(c.id);
            }}
          />
        ) : null}
        {colorName.trim() ? (
          <Badge
            label={colorId ? "لون موجود" : "لون جديد — يُنشأ مع الفاتورة"}
            tone={colorId ? "positive" : "warning"}
          />
        ) : null}
        {!colorId ? (
          <Field
            label="رقم اللون"
            fieldId="entry-color-code"
            {...chain("entry-color-code")}
            value={colorCode}
            onChangeText={setColorCode}
          />
        ) : null}
      </Section>

      <Section title="بيانات الوزن">
        <Pair>
          <Half>
            <MoneyInput
              label="الوزن القائم (كغ)"
              fieldId="entry-gross"
              {...chain("entry-gross")}
              initialText={num(d.grossKg)}
              onChangeAmount={setGrossKg}
            />
          </Half>
          <Half>
            <MoneyInput
              label="الوزن الصافي (كغ) *"
              fieldId="entry-kg"
              {...chain("entry-kg")}
              initialText={num(initial?.quantityKg)}
              error={attempted && problems.includes("no-kg") ? LINE_PROBLEM_TEXT["no-kg"] : null}
              onChangeAmount={setQty}
            />
          </Half>
        </Pair>
        <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
          إجمالي البند = الوزن الصافي × سعر الكيلو
        </Text>
      </Section>

      <Section title="بيانات الصباغة">
        <Field
          label="رقم الصبغة"
          fieldId="entry-dye"
          {...chain("entry-dye")}
          value={dyeBatch}
          onChangeText={setDyeBatch}
        />
      </Section>

      <Section title="بيانات الشراء">
        <MoneyInput
          key={priceKey}
          label={`السعر / كغ (${currency}) *`}
          fieldId="entry-price"
          {...chain("entry-price")}
          initialText={num(price)}
          error={attempted && problems.includes("no-price") ? LINE_PROBLEM_TEXT["no-price"] : null}
          onChangeAmount={setPrice}
        />
        {last.data ? (
          <Button
            label={`آخر سعر: ${money(last.data.pricePerKg, currency)} (${last.data.date})`}
            variant="ghost"
            block={false}
            testID="entry-last-price"
            onPress={() => {
              setPrice(last.data!.pricePerKg);
              setPriceKey((k) => k + 1);
            }}
          />
        ) : null}
        <MoneyInput
          label="الخصم (مبلغ)"
          fieldId="entry-line-discount"
          {...chain("entry-line-discount")}
          initialText={num(initial?.discountAmount)}
          onChangeAmount={setDiscount}
        />
      </Section>

      {specs ? (
        <Section title="مواصفات الصبغة">
          <Pair>
            <Half>
              <MoneyInput
                label="العرض (سم)"
                fieldId="entry-width"
                {...chain("entry-width")}
                initialText={num(initial?.widthCm)}
                onChangeAmount={setWidthCm}
              />
            </Half>
            <Half>
              <MoneyInput
                label="الغراماج (غ/م²)"
                fieldId="entry-gsm"
                {...chain("entry-gsm")}
                initialText={num(initial?.weightGsm)}
                onChangeAmount={setWeightGsm}
              />
            </Half>
          </Pair>
          <MoneyInput
            label={`سعر البيع / كغ (${currency})`}
            fieldId="entry-sale-price"
            {...chain("entry-sale-price")}
            initialText={num(initial?.salePricePerKg)}
            onChangeAmount={setSalePrice}
          />
        </Section>
      ) : (
        <Button
          label="العرض والغراماج وسعر البيع"
          variant="ghost"
          icon="add"
          block={false}
          testID="entry-specs"
          onPress={() => setSpecs(true)}
        />
      )}
    </Screen>
  );
}

/** What a line shows in the list: the desktop's columns in one row. */
function lineSubtitle(l: EntryDraftLine, currency: string): string {
  const gross = l.details?.grossKg ? ` (قائم ${kg(l.details.grossKg)})` : "";
  return `${kg(l.quantityKg)}${gross} · ${l.pieces} ثوب × ${money(l.pricePerKg, currency)}`;
}

function lineMeta(l: EntryDraftLine): string | null {
  return (
    [
      l.dyeBatch ? `رقم الصبغة ${l.dyeBatch}` : null,
      l.details?.kromaj ? `كراماج ${l.details.kromaj}` : null,
      l.details?.machineNo ? `ماكينة ${l.details.machineNo}` : null,
      !l.fabricId ? "قماش جديد" : !l.colorId ? "لون جديد" : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

export interface EntryFormProps {
  draft: EntryDraft;
  error: string | null;
  today: string;
  onSupplier(p: PickedParty): void;
  onCurrency(c: string): void;
  onRate(rate: number | null): void;
  /** Open the line page: a new line, a copy of the last one, or an existing line to edit. */
  onAddLine(): void;
  onCopyLine(key: string): void;
  onEditLine(key: string): void;
  onRemoveLine(key: string): void;
  onPatch(patch: Partial<EntryDraft>): void;
  onSave(): Promise<void>;
  onDiscard(): void;
}

export function EntryFormView(p: EntryFormProps) {
  const colors = useColors();
  const { draft } = p;
  const [attempted, setAttempted] = useState(false);
  const [chosen, setChosen] = useState<EntryDraftLine | null>(null);
  const [extras, setExtras] = useState(draft.discount > 0 || draft.tax > 0 || draft.shipping > 0);
  const totals = entryTotals(draft);
  const problems = entryProblems(draft);
  const show = (k: (typeof problems)[number]) => attempted && problems.includes(k);
  return (
    <Screen
      title="فاتورة دخول"
      subtitle={draft.supplier?.name ?? "شراء من مورد"}
      footerNotice={
        <>
          {attempted && problems.length > 0 ? (
            <Notice
              kind="error"
              text={problems.map((k) => ENTRY_PROBLEM_TEXT[k]).join("\n")}
              testID="entry-problems"
            />
          ) : null}
          {p.error ? <Notice kind="error" text={p.error} testID="entry-error" /> : null}
        </>
      }
      footer={
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.sm }}>
            <Text style={{ color: colors.mutedForeground }} testID="entry-footer-qty">
              {`${kg(totals.kg)} · ${totals.pieces} ثوب`}
            </Text>
            <Text testID="entry-total" style={{ fontWeight: "700", writingDirection: "ltr" }}>
              {money(totals.total, draft.currency)}
            </Text>
          </View>
          <Button
            label="حفظ الفاتورة"
            busyLabel="جارٍ الحفظ…"
            testID="entry-save"
            onPress={async () => {
              setAttempted(true);
              if (problems.length === 0) await p.onSave();
            }}
          />
        </>
      }
    >
      <Section title="بيانات الفاتورة">
        <PartyPicker
          kind="supplier"
          value={draft.supplier}
          onPick={p.onSupplier}
          error={show("no-supplier")}
        />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Field
              label="رقم الفاتورة"
              fieldId="entry-invoice-ref"
              value={draft.reference}
              placeholder="رقم فاتورة المورد"
              onChangeText={(reference) => p.onPatch({ reference })}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="التاريخ"
              fieldId="entry-date"
              value={draft.date}
              placeholder={p.today}
              keyboardType="numbers-and-punctuation"
              error={show("bad-date") ? ENTRY_PROBLEM_TEXT["bad-date"] : null}
              onChangeText={(date) => p.onPatch({ date: date.trim() })}
            />
          </View>
        </View>
        <Chips
          options={CURRENCY_OPTIONS}
          value={draft.currency}
          onChange={p.onCurrency}
          testIDPrefix="entry-currency"
        />
        {draft.currency !== "USD" ? (
          <MoneyInput
            label="سعر الصرف (ل.س / $)"
            fieldId="entry-rate"
            initialText={draft.exchangeRate ? String(draft.exchangeRate) : ""}
            error={
              show("no-rate")
                ? "سعر الصرف مطلوب"
                : show("bad-rate")
                  ? ENTRY_PROBLEM_TEXT["bad-rate"]
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
            testID="entry-add-line"
            onPress={p.onAddLine}
          />
        }
      >
        {draft.lines.length === 0 ? (
          <EmptyState
            icon="cube-outline"
            title="لا بنود بعد"
            hint="كل بند يدخل المخزون صبغةً جديدة باسم القماش واللون."
          />
        ) : (
          draft.lines.map((l, i) => (
            <ListRow
              key={l.key}
              testID="entry-line"
              accessibilityLabel={`بند ${l.fabricName} ${l.colorName}`}
              title={`${l.fabricName} · ${l.colorName}`}
              subtitle={lineSubtitle(l, draft.currency)}
              meta={lineMeta(l)}
              value={money(entryLineTotal(l), draft.currency)}
              onPress={() => setChosen(l)}
              last={i === draft.lines.length - 1}
            />
          ))
        )}
      </Section>
      {show("no-lines") ? <Notice kind="error" text={ENTRY_PROBLEM_TEXT["no-lines"]} /> : null}

      <Section title="المجاميع" testID="entry-totals">
        <KeyValue label="الكمية" value={kg(totals.kg)} />
        <KeyValue label="عدد الأثواب" value={String(totals.pieces)} />
        <KeyValue label="المجموع" value={money(totals.subtotal, draft.currency)} />
        {extras ? (
          <>
            <MoneyInput
              label="الخصم (مبلغ)"
              fieldId="entry-discount"
              initialText={draft.discount ? String(draft.discount) : ""}
              onChangeAmount={(v) => p.onPatch({ discount: v ?? 0 })}
            />
            <MoneyInput
              label="الضريبة (مبلغ)"
              fieldId="entry-tax"
              initialText={draft.tax ? String(draft.tax) : ""}
              onChangeAmount={(v) => p.onPatch({ tax: v ?? 0 })}
            />
            <MoneyInput
              label="الشحن (مبلغ)"
              fieldId="entry-shipping"
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
        <KeyValue label="الإجمالي الكلي" value={money(totals.total, draft.currency)} strong />
        <MoneyInput
          label="المدفوع للمورد الآن"
          fieldId="entry-paid"
          initialText={draft.paid ? String(draft.paid) : ""}
          error={show("paid-over-total") ? ENTRY_PROBLEM_TEXT["paid-over-total"] : null}
          onChangeAmount={(v) => p.onPatch({ paid: v ?? 0 })}
        />
        {draft.paid > 0 ? (
          <Chips
            options={PAYMENT_OPTIONS}
            value={draft.paymentMethod}
            onChange={(paymentMethod) => p.onPatch({ paymentMethod })}
            testIDPrefix="entry-method"
          />
        ) : null}
        <KeyValue
          label="المتبقي للمورد"
          value={money(totals.due, draft.currency)}
          strong
          tone={totals.due > 0 ? "warning" : "positive"}
        />
        <Field
          label="ملاحظات (اختياري)"
          fieldId="entry-notes"
          value={draft.notes}
          multiline
          onChangeText={(notes) => p.onPatch({ notes })}
        />
      </Section>

      {draft.supplier || draft.lines.length > 0 ? (
        <Button label="مسح المسودة" variant="ghost" onPress={p.onDiscard} />
      ) : null}

      <Sheet
        visible={chosen !== null}
        title={chosen ? `${chosen.fabricName} · ${chosen.colorName}` : ""}
        onClose={() => setChosen(null)}
        testID="entry-line-actions"
        footer={
          <View style={{ gap: spacing.sm }}>
            <Button
              label="تعديل البند"
              testID="entry-line-edit"
              onPress={() => {
                if (chosen) p.onEditLine(chosen.key);
                setChosen(null);
              }}
            />
            <Button
              label="بند جديد بنفس القماش واللون"
              variant="secondary"
              testID="entry-line-copy"
              onPress={() => {
                if (chosen) p.onCopyLine(chosen.key);
                setChosen(null);
              }}
            />
            <Button
              label="حذف البند"
              variant="danger"
              testID="entry-line-remove"
              onPress={() => {
                if (chosen) p.onRemoveLine(chosen.key);
                setChosen(null);
              }}
            />
          </View>
        }
      >
        {chosen ? (
          <View style={{ gap: spacing.xs }}>
            <KeyValue label="الوزن الصافي" value={kg(chosen.quantityKg)} />
            {chosen.details?.grossKg ? (
              <KeyValue label="الوزن القائم" value={kg(chosen.details.grossKg)} />
            ) : null}
            <KeyValue label="الأثواب" value={String(chosen.pieces)} />
            <KeyValue label="السعر / كغ" value={money(chosen.pricePerKg, draft.currency)} />
            {chosen.discountAmount ? (
              <KeyValue label="الخصم" value={money(chosen.discountAmount, draft.currency)} />
            ) : null}
            {chosen.dyeBatch ? <KeyValue label="رقم الصبغة" value={chosen.dyeBatch} /> : null}
            {chosen.details?.kromaj ? (
              <KeyValue label="كراماج" value={chosen.details.kromaj} />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
