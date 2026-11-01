// One invoice (FR-19), laid out like the desktop's invoice page (src/routes/invoices.$id.tsx): «بيانات الفاتورة»
// (reference, type, date, currency, pieces, rate and USD equivalent, party with phone), the lines with each roll's
// details (dye lot, pieces, machine, كراماج, السحب, gross weight — from the line note the desktop writes), «ملخص الدفع»
// with the linked vouchers and a new receipt / payment, the notes, share as PDF, and cancel for admin/accountant.
import { useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { parseInvoiceNotes, parseLineNote } from "../core/lineNote";
import { isAdminLike, canWriteOffline, type Role } from "../core/roles";
import type { InvoiceLineView, InvoiceView } from "../core/invoiceView";
import { PAYMENT_LABEL } from "../print/desktopInvoiceHtml";
import { kg, money } from "./format";
import { spacing } from "./theme";
import { useColors } from "./themeContext-core";
import { Badge, Button, ConfirmSheet, KeyValue, ListRow, Notice, Screen, Section } from "./kit";

const TYPE_LABEL: Record<string, string> = { sale: "فاتورة بيع", entry: "فاتورة دخول" };

/** The roll details the desktop prints under a line, plus the gross weight and free text of the note. */
export function lineFacts(l: InvoiceLineView): string[] {
  const n = parseLineNote(l.note);
  return [
    n.machineNo && `ماكينة ${n.machineNo}`,
    n.chromaj ? `كراماج ${n.chromaj}` : l.weightGsm ? `كراماج ${l.weightGsm}` : "",
    n.draw && `سحب ${n.draw}`,
    n.grossKg && `قائم ${kg(Number(n.grossKg))}`,
    l.widthCm ? `عرض ${l.widthCm} سم` : "",
    n.reference && `مرجعية ${n.reference}`,
    n.source && `مصدر ${n.source}`,
    n.freeText,
  ].filter(Boolean) as string[];
}

export function InvoiceDetailView({
  view,
  role,
  error,
  onCancel,
  onOpenParty,
  onNewVoucher,
  shareSlot,
}: {
  view: InvoiceView;
  role: Role;
  error: string | null;
  onCancel(): Promise<void> | void;
  onOpenParty?: () => void;
  /** A receipt (sale) or payment (purchase) for this invoice's party. */
  onNewVoucher?: () => void;
  shareSlot?: React.ReactNode;
}) {
  const colors = useColors();
  const [confirming, setConfirming] = useState(false);
  const i = view.invoice;
  const sale = i.type === "sale";
  const cancelled = i.status === "cancelled";
  const title = TYPE_LABEL[i.type] ?? "فاتورة";
  const c = i.currency;
  const due = Number(i.amountDue);
  const notes = parseInvoiceNotes(i.notes);
  const pieces = i.piecesCount ?? view.lines.reduce((s, l) => s + (l.pieces || 0), 0);
  const totalKg = Math.round(view.lines.reduce((s, l) => s + l.quantityKg, 0) * 100) / 100;
  const rate = Number(i.exchangeRate);
  return (
    <Screen
      title={`${title} ${i.number}`}
      subtitle={`${view.partyName} · ${String(i.date).slice(0, 10)}`}
      scrollToTopKey={i.status}
      footer={shareSlot}
    >
      {cancelled ? (
        <Notice kind="warning" text="هذه الفاتورة ملغاة." testID="invoice-cancelled" />
      ) : null}
      <Section title="بيانات الفاتورة" testID="invoice-info">
        <KeyValue
          label="الحالة"
          value={
            <Badge
              label={cancelled ? "ملغاة" : due > 0 ? "غير مسددة بالكامل" : "مسددة"}
              tone={cancelled ? "negative" : due > 0 ? "warning" : "positive"}
            />
          }
        />
        {/* Type and number are the page title; the reference only when it is a different number. */}
        {i.reference && i.reference !== i.number ? (
          <KeyValue label="الرقم المرجعي" value={i.reference} testID="invoice-reference" />
        ) : null}
        <KeyValue label="التاريخ" value={String(i.date).slice(0, 10)} />
        <KeyValue label="العملة" value={c} />
        {rate > 0 && c !== "USD" ? (
          <>
            <KeyValue label="سعر الصرف" value={rate.toLocaleString("en-US")} />
            {i.baseTotal ? (
              <KeyValue label="المعادل بالدولار" value={money(Number(i.baseTotal), "USD")} />
            ) : null}
          </>
        ) : null}
        <KeyValue label="الكمية" value={kg(totalKg)} />
        <KeyValue label="عدد الأثواب" value={String(pieces)} testID="invoice-pieces" />
        {i.paymentMethod ? (
          <KeyValue label="طريقة الدفع" value={PAYMENT_LABEL[i.paymentMethod] ?? i.paymentMethod} />
        ) : null}
      </Section>
      <Section padded={false}>
        {onOpenParty ? (
          <ListRow
            title={view.partyName}
            subtitle={[sale ? "العميل" : "المورد", view.party.phone].filter(Boolean).join(" · ")}
            onPress={onOpenParty}
            last
          />
        ) : (
          <View style={{ padding: spacing.lg }}>
            <KeyValue label={sale ? "العميل" : "المورد"} value={view.partyName} />
          </View>
        )}
      </Section>
      <Section title={`البنود (${view.lines.length})`} padded={false}>
        {view.lines.map((l, idx) => {
          const facts = lineFacts(l);
          return (
            <ListRow
              key={l.id}
              testID="invoice-line"
              title={`${l.fabric} · ${l.color}${l.colorCode ? ` (${l.colorCode})` : ""}`}
              subtitle={`صبغة ${l.rollNo}${l.dyeBatch ? ` · رقم الصبغة ${l.dyeBatch}` : ""} · ${kg(l.quantityKg)} × ${money(l.pricePerKg, c)}${l.pieces ? ` · ${l.pieces} ثوب` : ""}`}
              meta={
                [facts.join(" · "), l.discountAmount ? `خصم ${money(l.discountAmount, c)}` : ""]
                  .filter(Boolean)
                  .join(" · ") || null
              }
              value={money(l.lineTotal, c)}
              last={idx === view.lines.length - 1}
            />
          );
        })}
      </Section>
      <Section title="ملخص الدفع" testID="invoice-payment">
        <KeyValue label="مجموع الأصناف" value={money(Number(i.subtotal), c)} />
        {Number(i.discount) ? (
          <KeyValue label="خصم الفاتورة" value={money(Number(i.discount), c)} />
        ) : null}
        {Number(i.tax) ? <KeyValue label="الضريبة" value={money(Number(i.tax), c)} /> : null}
        {Number(i.shipping) ? (
          <KeyValue label="الشحن" value={money(Number(i.shipping), c)} />
        ) : null}
        <KeyValue label="الإجمالي الكلي" value={money(Number(i.total), c)} strong />
        <KeyValue label={sale ? "المقبوض" : "المدفوع للمورد"} value={money(Number(i.paid), c)} />
        <KeyValue
          label={sale ? "الباقي على العميل" : "الباقي للمورد"}
          value={money(due, c)}
          strong
          tone={due > 0 ? "warning" : "positive"}
        />
        {view.vouchers.length > 0 ? (
          <View style={{ gap: spacing.xs }} testID="invoice-vouchers">
            <Text style={{ color: colors.mutedForeground, fontWeight: "600" }}>
              السندات المرتبطة
            </Text>
            {view.vouchers.map((v) => (
              <KeyValue
                key={v.id}
                label={`${v.kind === "receipt" ? "سند قبض" : "سند صرف"} ${v.number} · ${v.date}`}
                value={`${money(v.amount, v.currency)} · ${PAYMENT_LABEL[v.method] ?? v.method}`}
              />
            ))}
          </View>
        ) : null}
        {onNewVoucher && !cancelled && due > 0 && canWriteOffline(role) ? (
          <Button
            label={sale ? "سند قبض جديد" : "سند صرف جديد"}
            variant="secondary"
            icon="add"
            testID="invoice-new-voucher"
            onPress={onNewVoucher}
          />
        ) : null}
      </Section>
      {notes.freeText ? (
        <Section title="ملاحظات" testID="invoice-notes">
          <Text>{notes.freeText}</Text>
        </Section>
      ) : null}
      {error ? <Notice kind="error" text={error} testID="invoice-error" /> : null}
      {isAdminLike(role) && !cancelled ? (
        <Button label="إلغاء الفاتورة" variant="danger" onPress={() => setConfirming(true)} />
      ) : null}
      <ConfirmSheet
        visible={confirming}
        title="إلغاء الفاتورة"
        message={`ستُلغى الفاتورة ${i.number}: يعود المخزون ويُعكس أثرها على الرصيد والصندوق. لا يمكن التراجع.`}
        confirmLabel="إلغاء الفاتورة"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await onCancel();
          setConfirming(false);
        }}
      />
    </Screen>
  );
}
