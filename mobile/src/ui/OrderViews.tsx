// Orders (FR-27): list, new order, and detail with fulfil (by one of the customer's sale invoices) or cancel. Pending
// conflicts on the same item are shown read-only with the desktop's note.
import { useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import {
  CONFLICT_NOTE,
  isOrderActive,
  ORDER_STATUS_LABEL,
  type OrderDetail,
  type OrderRow,
} from "../core/orders";
import { Field } from "./Field";
import { kg } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { spacing } from "./theme";
import { useColors } from "./themeContext-core";
import {
  Badge,
  Button,
  ConfirmSheet,
  EmptyState,
  HeaderIcon,
  KeyValue,
  ListRow,
  Notice,
  Screen,
  Section,
} from "./kit";

function statusTone(status: string): "positive" | "warning" | "negative" | "neutral" {
  if (status === "fulfilled") return "positive";
  if (status === "cancelled") return "negative";
  if (isOrderActive(status)) return "warning";
  return "neutral";
}

export function OrderListView({
  rows,
  canWrite,
  onOpen,
  onNew,
}: {
  rows: OrderRow[] | undefined;
  canWrite: boolean;
  onOpen(id: string): void;
  onNew(): void;
}) {
  const list = rows ?? [];
  return (
    <Screen
      title="الطلبيات"
      subtitle={rows ? `${list.filter((o) => isOrderActive(o.status)).length} مفتوحة` : null}
      headerActions={
        canWrite ? (
          <HeaderIcon icon="add" label="طلبية جديدة" onPress={onNew} testID="order-new" />
        ) : null
      }
    >
      {list.length === 0 ? (
        <View testID="orders-empty">
          <EmptyState
            icon="clipboard-outline"
            title="لا طلبيات"
            {...(canWrite ? { action: { label: "طلبية جديدة", onPress: onNew } } : {})}
          />
        </View>
      ) : (
        <Section padded={false}>
          {list.map((o, i) => (
            <ListRow
              key={o.id}
              testID="order-row"
              accessibilityLabel={`طلبية ${o.code}`}
              title={`${o.code} · ${o.customer}`}
              subtitle={`${o.date} · ${kg(o.totalKg)}`}
              value={
                <Badge
                  label={ORDER_STATUS_LABEL[o.status] ?? o.status}
                  tone={statusTone(o.status)}
                />
              }
              onPress={() => onOpen(o.id)}
              last={i === list.length - 1}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

export interface OrderDraftItem {
  key: string;
  fabricName: string;
  colorName: string;
  requestedKg: number;
}

export function OrderFormView({
  customer,
  items,
  error,
  onCustomer,
  onAddItem,
  onRemoveItem,
  onSave,
}: {
  customer: PickedParty | null;
  items: OrderDraftItem[];
  error: string | null;
  onCustomer(p: PickedParty): void;
  onAddItem(item: Omit<OrderDraftItem, "key">): void;
  onRemoveItem(key: string): void;
  onSave(): Promise<void> | void;
}) {
  const [fabric, setFabric] = useState("");
  const [color, setColor] = useState("");
  const [qty, setQty] = useState<number | null>(null);
  const [formKey, setFormKey] = useState(0);
  const canAdd = fabric.trim().length > 0 && color.trim().length > 0 && (qty ?? 0) > 0;
  return (
    <Screen
      title="طلبية جديدة"
      footerNotice={<>{error ? <Notice kind="error" text={error} testID="order-error" /> : null}</>}
      footer={
        <Button
          label="حفظ الطلبية"
          busyLabel="جارٍ الحفظ…"
          disabled={!customer || items.length === 0}
          onPress={onSave}
          testID="order-save"
        />
      }
    >
      <Section>
        <PartyPicker kind="customer" value={customer} onPick={onCustomer} />
      </Section>
      <Section title="بند جديد" key={formKey}>
        <Field label="القماش" fieldId="order-fabric" value={fabric} onChangeText={setFabric} />
        <Field label="اللون" fieldId="order-color" value={color} onChangeText={setColor} />
        <MoneyInput label="الكمية المطلوبة (كغ)" fieldId="order-kg" onChangeAmount={setQty} />
        <Button
          label="إضافة البند"
          variant="secondary"
          icon="add"
          disabled={!canAdd}
          onPress={() => {
            onAddItem({
              fabricName: fabric.trim(),
              colorName: color.trim(),
              requestedKg: qty ?? 0,
            });
            setFabric("");
            setColor("");
            setQty(null);
            setFormKey((k) => k + 1);
          }}
        />
      </Section>
      {items.length > 0 ? (
        <Section title={`البنود (${items.length})`} padded={false}>
          {items.map((i, idx) => (
            <ListRow
              key={i.key}
              testID="order-item"
              title={`${i.fabricName} · ${i.colorName}`}
              value={kg(i.requestedKg)}
              accessibilityLabel={`حذف ${i.fabricName} ${i.colorName}`}
              meta="اضغط للحذف"
              onPress={() => onRemoveItem(i.key)}
              last={idx === items.length - 1}
            />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

export function OrderDetailView({
  detail,
  canWrite,
  candidates,
  error,
  onCancel,
  onFulfil,
}: {
  detail: OrderDetail;
  canWrite: boolean;
  candidates: Array<{ id: string; number: string; date: string }>;
  error: string | null;
  onCancel(): Promise<void> | void;
  onFulfil(invoiceId: string): Promise<void> | void;
}) {
  const colors = useColors();
  const [confirming, setConfirming] = useState(false);
  const o = detail.order;
  const active = isOrderActive(o.status);
  return (
    <Screen title={`طلبية ${o.code}`} subtitle={o.customerNameSnapshot}>
      <Section>
        <KeyValue
          label="الحالة"
          value={
            <Badge label={ORDER_STATUS_LABEL[o.status] ?? o.status} tone={statusTone(o.status)} />
          }
          testID="order-status"
        />
        <KeyValue label="التاريخ" value={o.date} />
        <KeyValue label="العميل" value={o.customerNameSnapshot} />
      </Section>
      <Section title="البنود" padded={false}>
        {o.items.map((i, idx) => (
          <ListRow
            key={i.id}
            title={`${i.fabricName} · ${i.colorName}`}
            value={kg(i.requestedKg)}
            last={idx === o.items.length - 1}
          />
        ))}
      </Section>
      {detail.conflicts.length > 0 ? (
        <Section title="طلبيات معلّقة أخرى على نفس الصنف" testID="order-conflicts">
          {detail.conflicts.map((c) => (
            <Text key={c.orderId}>{`${c.code} · ${c.customer} · ${c.items.join("، ")}`}</Text>
          ))}
          <Text style={{ color: colors.mutedForeground }}>{CONFLICT_NOTE}</Text>
        </Section>
      ) : null}
      {error ? <Notice kind="error" text={error} testID="order-detail-error" /> : null}
      {canWrite && active ? (
        <>
          <Section title="تنفيذ بفاتورة بيع للعميل" padded={false}>
            {candidates.length === 0 ? (
              <View style={{ padding: spacing.lg }}>
                <Text style={{ color: colors.mutedForeground }}>لا فواتير بيع لهذا العميل بعد</Text>
              </View>
            ) : (
              candidates.map((c, idx) => (
                <ListRow
                  key={c.id}
                  testID="fulfil-invoice"
                  accessibilityLabel={`تنفيذ بالفاتورة ${c.number}`}
                  title={`تنفيذ بالفاتورة ${c.number}`}
                  subtitle={c.date}
                  onPress={() => void onFulfil(c.id)}
                  last={idx === candidates.length - 1}
                />
              ))
            )}
          </Section>
          <Button label="إلغاء الطلبية" variant="danger" onPress={() => setConfirming(true)} />
        </>
      ) : null}
      <ConfirmSheet
        visible={confirming}
        title="إلغاء الطلبية"
        message={`هل تريد إلغاء الطلبية ${o.code}؟ لا يمكن التراجع عن الإلغاء.`}
        confirmLabel="إلغاء الطلبية"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await onCancel();
          setConfirming(false);
        }}
      />
    </Screen>
  );
}
