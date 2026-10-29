// Order screens' views (FR-27): list, new order form, and detail with cancel / fulfil. Pending conflicts are read-only.
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import {
  CONFLICT_NOTE,
  isOrderActive,
  ORDER_STATUS_LABEL,
  type OrderDetail,
  type OrderRow,
} from "../core/orders";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

function Btn({
  label,
  onPress,
  danger,
  testID,
}: {
  label: string;
  onPress(): void;
  danger?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      {...(testID ? { testID } : {})}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: danger ? colors.negative : colors.border,
        marginTop: spacing.sm,
      }}
    >
      <Text style={{ color: danger ? colors.negative : colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function OrderListView({
  rows,
  canWrite,
  onOpen,
  onNew,
}: {
  rows: OrderRow[];
  canWrite: boolean;
  onOpen(id: string): void;
  onNew(): void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}>
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>الطلبيات</Text>
        {rows.length === 0 ? <Text testID="orders-empty">لا طلبيات</Text> : null}
        {rows.map((o) => (
          <Pressable
            key={o.id}
            testID="order-row"
            accessibilityRole="button"
            accessibilityLabel={`طلبية ${o.code}`}
            onPress={() => onOpen(o.id)}
            style={{
              minHeight: TOUCH_TARGET,
              padding: spacing.lg,
              marginBottom: spacing.sm,
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ fontSize: fontSize.body }}>{`${o.code} · ${o.customer}`}</Text>
            <Text style={{ color: colors.mutedForeground }}>
              {`${o.date} · ${o.totalKg} كغ · ${ORDER_STATUS_LABEL[o.status] ?? o.status}`}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {canWrite ? <PrimaryActionBar label="طلبية جديدة" onPress={onNew} /> : null}
    </View>
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
  busy,
  error,
  onCustomer,
  onAddItem,
  onRemoveItem,
  onSave,
}: {
  customer: PickedParty | null;
  items: OrderDraftItem[];
  busy: boolean;
  error: string | null;
  onCustomer(p: PickedParty): void;
  onAddItem(item: Omit<OrderDraftItem, "key">): void;
  onRemoveItem(key: string): void;
  onSave(): void;
}) {
  const [fabric, setFabric] = useState("");
  const [color, setColor] = useState("");
  const [kg, setKg] = useState<number | null>(null);
  const canAdd = fabric.trim().length > 0 && color.trim().length > 0 && (kg ?? 0) > 0;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 140 }}
      >
        <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>طلبية جديدة</Text>
        <PartyPicker kind="customer" value={customer} onPick={onCustomer} />
        <Field label="القماش" fieldId="order-fabric" value={fabric} onChangeText={setFabric} />
        <Field label="اللون" fieldId="order-color" value={color} onChangeText={setColor} />
        <MoneyInput label="الكمية المطلوبة (كغ)" fieldId="order-kg" onChangeAmount={setKg} />
        <Btn
          label="إضافة البند"
          onPress={() => {
            if (!canAdd) return;
            onAddItem({ fabricName: fabric.trim(), colorName: color.trim(), requestedKg: kg ?? 0 });
            setFabric("");
            setColor("");
          }}
        />
        {items.map((i) => (
          <View
            key={i.key}
            testID="order-item"
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              padding: spacing.md,
              marginBottom: spacing.sm,
            }}
          >
            <Text>{`${i.fabricName} · ${i.colorName} · ${i.requestedKg} كغ`}</Text>
            <Btn label="حذف البند" danger onPress={() => onRemoveItem(i.key)} />
          </View>
        ))}
        {error ? (
          <Text testID="order-error" style={{ color: colors.negative, marginTop: spacing.md }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ الطلبية"}
        disabled={busy || !customer || items.length === 0}
        onPress={onSave}
      />
    </View>
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
  onCancel(): void;
  onFulfil(invoiceId: string): void;
}) {
  const o = detail.order;
  const active = isOrderActive(o.status);
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 80 }}>
      <Text style={{ fontSize: fontSize.title }}>{o.code}</Text>
      <Text testID="order-status">{ORDER_STATUS_LABEL[o.status] ?? o.status}</Text>
      <Text>{`${o.customerNameSnapshot} · ${o.date}`}</Text>
      {o.items.map((i) => (
        <Text key={i.id} style={{ marginTop: spacing.xs }}>
          {`${i.fabricName} · ${i.colorName} · ${i.requestedKg} كغ`}
        </Text>
      ))}
      {detail.conflicts.length > 0 ? (
        <View
          testID="order-conflicts"
          style={{
            marginTop: spacing.lg,
            padding: spacing.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.negative }}>طلبيات معلّقة أخرى على نفس الصنف</Text>
          {detail.conflicts.map((c) => (
            <Text key={c.orderId}>{`${c.code} · ${c.customer} · ${c.items.join("، ")}`}</Text>
          ))}
          <Text style={{ color: colors.mutedForeground }}>{CONFLICT_NOTE}</Text>
        </View>
      ) : null}
      {error ? (
        <Text testID="order-detail-error" style={{ color: colors.negative, marginTop: spacing.md }}>
          {error}
        </Text>
      ) : null}
      {canWrite && active ? (
        <View style={{ marginTop: spacing.lg }}>
          <Text style={{ color: colors.mutedForeground }}>تنفيذ بفاتورة بيع للعميل</Text>
          {candidates.length === 0 ? <Text>لا فواتير بيع لهذا العميل</Text> : null}
          {candidates.map((c) => (
            <Btn
              key={c.id}
              testID="fulfil-invoice"
              label={`تنفيذ بالفاتورة ${c.number}`}
              onPress={() => onFulfil(c.id)}
            />
          ))}
          <Btn label="إلغاء الطلبية" danger onPress={onCancel} />
        </View>
      ) : null}
    </ScrollView>
  );
}
