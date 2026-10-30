// One invoice (FR-19): its type, party, lines (fabric · colour · lot, kg × price), totals, what was paid and what is due,
// share as PDF, and cancel for admin/accountant (the desktop's cancel use-case reverses stock and balance).
import { useState } from "react";
import { isAdminLike, type Role } from "../core/roles";
import type { InvoiceView } from "../core/invoiceView";
import { kg, money } from "./format";
import { Badge, Button, ConfirmSheet, KeyValue, ListRow, Notice, Screen, Section } from "./kit";

const TYPE_LABEL: Record<string, string> = { sale: "فاتورة بيع", entry: "فاتورة دخول" };

export function InvoiceDetailView({
  view,
  role,
  error,
  onCancel,
  onOpenParty,
  shareSlot,
}: {
  view: InvoiceView;
  role: Role;
  error: string | null;
  onCancel(): Promise<void> | void;
  onOpenParty?: () => void;
  shareSlot?: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const i = view.invoice;
  const cancelled = i.status === "cancelled";
  const title = TYPE_LABEL[i.type] ?? "فاتورة";
  const c = i.currency;
  return (
    <Screen
      title={`${title} ${i.number}`}
      subtitle={`${view.partyName} · ${String(i.date).slice(0, 10)}`}
      scrollToTopKey={i.status}
    >
      {cancelled ? (
        <Notice kind="warning" text="هذه الفاتورة ملغاة." testID="invoice-cancelled" />
      ) : null}
      <Section>
        <KeyValue
          label="الحالة"
          value={
            <Badge
              label={cancelled ? "ملغاة" : Number(i.amountDue) > 0 ? "غير مسددة بالكامل" : "مسددة"}
              tone={cancelled ? "negative" : Number(i.amountDue) > 0 ? "warning" : "positive"}
            />
          }
        />
        {onOpenParty ? (
          <ListRow
            title={view.partyName}
            subtitle={i.type === "sale" ? "العميل" : "المورد"}
            onPress={onOpenParty}
            last
          />
        ) : (
          <KeyValue label={i.type === "sale" ? "العميل" : "المورد"} value={view.partyName} />
        )}
      </Section>
      <Section title={`البنود (${view.lines.length})`} padded={false}>
        {view.lines.map((l, idx) => (
          <ListRow
            key={l.id}
            title={`${l.fabric} · ${l.color}`}
            subtitle={`صبغة ${l.rollNo} · ${kg(l.quantityKg)} × ${money(l.pricePerKg, c)}${l.pieces ? ` · ${l.pieces} ثوب` : ""}`}
            meta={l.discountAmount ? `خصم ${money(l.discountAmount, c)}` : null}
            value={money(l.lineTotal, c)}
            last={idx === view.lines.length - 1}
          />
        ))}
      </Section>
      <Section title="الإجمالي">
        <KeyValue label="مجموع البنود" value={money(Number(i.subtotal), c)} />
        {Number(i.discount) ? (
          <KeyValue label="الخصم" value={money(Number(i.discount), c)} />
        ) : null}
        {Number(i.tax) ? <KeyValue label="الضريبة" value={money(Number(i.tax), c)} /> : null}
        {Number(i.shipping) ? (
          <KeyValue label="الشحن" value={money(Number(i.shipping), c)} />
        ) : null}
        <KeyValue label="الإجمالي" value={money(Number(i.total), c)} strong />
        <KeyValue label="المدفوع" value={money(Number(i.paid), c)} />
        <KeyValue
          label="المتبقي"
          value={money(Number(i.amountDue), c)}
          strong
          tone={Number(i.amountDue) > 0 ? "warning" : "positive"}
        />
        {c !== "USD" && i.exchangeRate ? (
          <KeyValue label="سعر الصرف" value={String(i.exchangeRate)} />
        ) : null}
      </Section>
      {error ? <Notice kind="error" text={error} testID="invoice-error" /> : null}
      {shareSlot}
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
