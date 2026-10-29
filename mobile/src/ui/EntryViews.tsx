// The purchase (entry) invoice (FR-16) on one screen: supplier, currency, lines, totals and payment. A line takes an
// existing fabric and colour or names new ones; new fabrics, colours and the dye lots are created with the invoice in one
// save (documents.createEntryInvoice).
import { useState } from "react";
import { View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Text } from "./Text";
import { getApp } from "../core/appRuntime";
import { pickColors, pickFabrics } from "../core/inventoryPicker";
import {
  ENTRY_PROBLEM_TEXT,
  entryProblems,
  entryTotals,
  type EntryDraft,
  type EntryDraftLine,
} from "../core/entryDraft";
import { queryKeys } from "../hooks/queryKeys";
import { Field } from "./Field";
import { kg, money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { CURRENCY_OPTIONS } from "./SaleViews";
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

export function EntryLineSheet({
  visible,
  currency,
  onSave,
  onClose,
}: {
  visible: boolean;
  currency: string;
  onSave(line: LineFormValue): void;
  onClose(): void;
}) {
  const colors = useColors();
  const [fabricName, setFabricName] = useState("");
  const [fabricId, setFabricId] = useState<string | undefined>();
  const [colorName, setColorName] = useState("");
  const [colorId, setColorId] = useState<string | undefined>();
  const [dyeBatch, setDyeBatch] = useState("");
  const [qty, setQty] = useState<number | null>(null);
  const [pieces, setPieces] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const fabrics = useQuery({
    queryKey: [...queryKeys.inventory, "entry-fabrics", fabricName.trim()],
    enabled: visible && fabricName.trim().length > 0 && !fabricId,
    queryFn: async () => pickFabrics(await phone(), fabricName.trim()),
  });
  const colorsOf = useQuery({
    queryKey: [...queryKeys.inventory, "entry-colors", fabricId ?? ""],
    enabled: visible && Boolean(fabricId),
    queryFn: async () => pickColors(await phone(), fabricId!),
  });
  const colorMatches = (colorsOf.data ?? []).filter((c) => c.name.includes(colorName.trim()));
  const valid =
    fabricName.trim() !== "" && colorName.trim() !== "" && (qty ?? 0) > 0 && price !== null;
  return (
    <Sheet
      visible={visible}
      title="بند جديد"
      onClose={onClose}
      testID="entry-line-form"
      footer={
        <Button
          label="حفظ البند"
          disabled={!valid}
          testID="entry-line-save"
          onPress={() =>
            onSave({
              ...(fabricId ? { fabricId } : {}),
              fabricName: fabricName.trim(),
              ...(colorId ? { colorId } : {}),
              colorName: colorName.trim(),
              dyeBatch: dyeBatch.trim(),
              quantityKg: qty ?? 0,
              pieces: pieces ?? 0,
              pricePerKg: price ?? 0,
            })
          }
        />
      }
    >
      <Field
        label="نوع القماش"
        fieldId="entry-fabric"
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
      <Field
        label="اللون"
        fieldId="entry-color"
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
      <Field
        label="رقم الصبغة (اختياري)"
        fieldId="entry-dye"
        value={dyeBatch}
        onChangeText={setDyeBatch}
      />
      <MoneyInput label="الوزن الصافي (كغ)" fieldId="entry-kg" onChangeAmount={setQty} />
      <MoneyInput
        label="عدد الأثواب"
        fieldId="entry-pieces"
        onChangeAmount={(v) => setPieces(v === null ? null : Math.round(v))}
      />
      <MoneyInput
        label={`سعر الكيلو (${currency})`}
        fieldId="entry-price"
        onChangeAmount={setPrice}
      />
      {qty && price !== null ? (
        <Text
          style={{ color: colors.mutedForeground }}
        >{`قيمة البند ${money(qty * price, currency)}`}</Text>
      ) : null}
    </Sheet>
  );
}

export interface EntryFormProps {
  draft: EntryDraft;
  error: string | null;
  onSupplier(p: PickedParty): void;
  onCurrency(c: string): void;
  onRate(rate: number | null): void;
  onAddLine(line: LineFormValue): void;
  onRemoveLine(key: string): void;
  onPatch(patch: Partial<EntryDraft>): void;
  onSave(): Promise<void>;
  onDiscard(): void;
}

export function EntryFormView(p: EntryFormProps) {
  const colors = useColors();
  const { draft } = p;
  const [attempted, setAttempted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const [removing, setRemoving] = useState<EntryDraftLine | null>(null);
  const [extras, setExtras] = useState(draft.discount > 0 || draft.tax > 0 || draft.shipping > 0);
  const totals = entryTotals(draft);
  const problems = entryProblems(draft);
  const show = (k: (typeof problems)[number]) => attempted && problems.includes(k);
  return (
    <Screen
      title="فاتورة دخول"
      subtitle={draft.supplier?.name ?? "شراء من مورد"}
      footer={
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: colors.mutedForeground }}>الإجمالي</Text>
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
      <Section title="المورد والعملة">
        <PartyPicker
          kind="supplier"
          value={draft.supplier}
          onPick={p.onSupplier}
          error={show("no-supplier")}
        />
        <Chips
          options={CURRENCY_OPTIONS}
          value={draft.currency}
          onChange={p.onCurrency}
          testIDPrefix="entry-currency"
        />
        {draft.currency !== "USD" ? (
          <MoneyInput
            label="سعر الصرف (ليرة لكل 1 دولار)"
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
            onPress={() => {
              setSheetKey((k) => k + 1);
              setAdding(true);
            }}
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
              subtitle={`${kg(l.quantityKg)} · ${l.pieces} ثوب × ${money(l.pricePerKg, draft.currency)}`}
              meta={
                [
                  l.dyeBatch ? `رقم الصبغة ${l.dyeBatch}` : null,
                  !l.fabricId ? "قماش جديد" : !l.colorId ? "لون جديد" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              }
              value={money(Math.round(l.quantityKg * l.pricePerKg * 100) / 100, draft.currency)}
              onPress={() => setRemoving(l)}
              last={i === draft.lines.length - 1}
            />
          ))
        )}
      </Section>
      {show("no-lines") ? <Notice kind="error" text={ENTRY_PROBLEM_TEXT["no-lines"]} /> : null}

      <Section title="الإجمالي والدفع" testID="entry-totals">
        <KeyValue label="مجموع البنود" value={money(totals.subtotal, draft.currency)} />
        {extras ? (
          <>
            <MoneyInput
              label="خصم على الفاتورة (مبلغ)"
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
        <KeyValue label="الإجمالي" value={money(totals.total, draft.currency)} strong />
        <MoneyInput
          label="المدفوع للمورد الآن"
          fieldId="entry-paid"
          initialText={draft.paid ? String(draft.paid) : ""}
          onChangeAmount={(v) => p.onPatch({ paid: v ?? 0 })}
        />
        <KeyValue
          label="المتبقي للمورد"
          value={money(totals.due, draft.currency)}
          strong
          tone={totals.due > 0 ? "warning" : "positive"}
        />
      </Section>

      {attempted && problems.length > 0 ? (
        <Notice
          kind="error"
          text={problems.map((k) => ENTRY_PROBLEM_TEXT[k]).join("\n")}
          testID="entry-problems"
        />
      ) : null}
      {p.error ? <Notice kind="error" text={p.error} testID="entry-error" /> : null}
      {draft.supplier || draft.lines.length > 0 ? (
        <Button label="مسح المسودة" variant="ghost" onPress={p.onDiscard} />
      ) : null}

      <EntryLineSheet
        key={sheetKey}
        visible={adding}
        currency={draft.currency}
        onClose={() => setAdding(false)}
        onSave={(line) => {
          setAdding(false);
          p.onAddLine(line);
        }}
      />
      <Sheet
        visible={removing !== null}
        title={removing ? `${removing.fabricName} · ${removing.colorName}` : ""}
        onClose={() => setRemoving(null)}
        footer={
          <Button
            label="حذف البند"
            variant="danger"
            onPress={() => {
              if (removing) p.onRemoveLine(removing.key);
              setRemoving(null);
            }}
          />
        }
      >
        {removing ? (
          <View style={{ gap: spacing.sm }}>
            <KeyValue label="الوزن" value={kg(removing.quantityKg)} />
            <KeyValue label="الأثواب" value={String(removing.pieces)} />
            <KeyValue label="سعر الكيلو" value={money(removing.pricePerKg, draft.currency)} />
            {removing.dyeBatch ? <KeyValue label="رقم الصبغة" value={removing.dyeBatch} /> : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
