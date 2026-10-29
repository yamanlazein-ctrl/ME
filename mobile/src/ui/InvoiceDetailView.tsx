import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { isAdminLike, type Role } from "../core/roles";
import type { InvoiceView } from "../core/invoiceView";
import { MoneyText } from "./MoneyText";
import { fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

export function InvoiceDetailView({
  view,
  role,
  error,
  onCancel,
  onShare,
  sendSlot,
}: {
  view: InvoiceView;
  role: Role;
  error: string | null;
  onCancel(): void;
  onShare(): void;
  sendSlot?: React.ReactNode;
}) {
  const colors = useColors();
  const i = view.invoice;
  const cancelled = i.status === "cancelled";
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl }}>
      <Text style={{ fontSize: fontSize.title }}>{i.number}</Text>
      <Text>{`${view.partyName} · ${i.date}`}</Text>
      {cancelled ? (
        <Text testID="invoice-cancelled" style={{ color: colors.negative }}>
          ملغاة
        </Text>
      ) : null}
      {view.lines.map((l) => (
        <View key={l.id} style={{ paddingVertical: spacing.sm }}>
          <Text>{`${l.fabric} · ${l.color} · ${l.rollNo}`}</Text>
          <Text>{`${l.quantityKg} كغ × ${l.pricePerKg} = ${l.lineTotal}`}</Text>
        </View>
      ))}
      <MoneyText amount={i.total} currency={i.currency} />
      <Text>{`المدفوع ${i.paid} · المتبقي ${i.amountDue}`}</Text>
      {error ? (
        <Text testID="invoice-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="مشاركة PDF"
        onPress={onShare}
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: colors.primary,
          borderRadius: radius.md,
          marginTop: spacing.lg,
        }}
      >
        <Text style={{ color: colors.primaryForeground }}>مشاركة PDF</Text>
      </Pressable>
      {sendSlot}
      {isAdminLike(role) && !cancelled ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="إلغاء الفاتورة"
          onPress={onCancel}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            marginTop: spacing.md,
          }}
        >
          <Text style={{ color: colors.negative }}>إلغاء الفاتورة</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
