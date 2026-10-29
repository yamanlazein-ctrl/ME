// The Home summary (FR-09, FR-10): one card per currency, never combined; quick actions follow the role.
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { canWriteOffline, type Role } from "../core/roles";
import type { HomeData } from "../hooks/useDashboard";
import { MoneyText } from "./MoneyText";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export type HomeAction = "sale" | "receipt" | "payment" | "expense" | "findParty";

export const HOME_ACTIONS: { id: HomeAction; label: string; write: boolean }[] = [
  { id: "sale", label: "بيع جديد", write: true },
  { id: "receipt", label: "سند قبض", write: true },
  { id: "payment", label: "سند دفع", write: true },
  { id: "expense", label: "مصروف", write: true },
  { id: "findParty", label: "بحث عن طرف", write: false },
];

function Card({
  title,
  children,
  testID,
}: {
  title: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View
      {...(testID ? { testID } : {})}
      style={{
        backgroundColor: colors.card,
        borderRadius: radius.lg,
        padding: spacing.lg,
        marginBottom: spacing.md,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text style={{ fontSize: fontSize.caption, color: colors.mutedForeground }}>{title}</Text>
      {children}
    </View>
  );
}

function currenciesOf(...maps: Array<Record<string, unknown>>): string[] {
  return [...new Set(maps.flatMap((m) => Object.keys(m)))].sort();
}

export function HomeView({
  data,
  role,
  lastSyncAt,
  onAction,
}: {
  data: HomeData;
  role: Role;
  lastSyncAt: string | null;
  onAction(action: HomeAction): void;
}) {
  const d = data.dashboard;
  const cashCurrencies = currenciesOf(d.cashbox.balanceByCurrency);
  const salesCurrencies = currenciesOf(d.todaySales.byCurrency);
  const owed = currenciesOf(data.receivables, data.payables);
  const actions = HOME_ACTIONS.filter((a) => !a.write || canWriteOffline(role));
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}>
      <Text style={{ fontSize: fontSize.headline, color: colors.foreground, marginBottom: spacing.xs }}>
        الرئيسية
      </Text>
      <Text style={{ color: colors.mutedForeground, marginBottom: spacing.lg }}>
        ملخص العمل اليومي
      </Text>
      {cashCurrencies.map((c) => (
        <Card key={c} title={`الصندوق — ${c}`} testID={`cashbox-card-${c}`}>
          <MoneyText amount={d.cashbox.balanceByCurrency[c] ?? 0} currency={c} />
        </Card>
      ))}
      <Card title="مبيعات اليوم" testID="today-sales">
        {salesCurrencies.length === 0 ? (
          <Text>لا مبيعات اليوم</Text>
        ) : (
          salesCurrencies.map((c) => (
            <MoneyText key={c} amount={d.todaySales.byCurrency[c]?.total ?? 0} currency={c} />
          ))
        )}
      </Card>
      <Card title="الذمم" testID="receivables-payables">
        {owed.map((c) => (
          <View key={c}>
            <Text>{`لنا (${c})`}</Text>
            <MoneyText amount={data.receivables[c] ?? 0} currency={c} />
            <Text>{`علينا (${c})`}</Text>
            <MoneyText amount={data.payables[c] ?? 0} currency={c} />
          </View>
        ))}
      </Card>
      <Text testID="last-sync" style={{ color: colors.mutedForeground, marginBottom: spacing.md }}>
        {lastSyncAt ? `آخر مزامنة: ${lastSyncAt}` : "لم تتم مزامنة بعد"}
      </Text>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.sm }}>
        إجراءات سريعة
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {actions.map((a) => (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            onPress={() => onAction(a.id)}
            style={{
              minHeight: TOUCH_TARGET,
              flexGrow: 1,
              flexBasis: "45%",
              justifyContent: "center",
              alignItems: "center",
              paddingHorizontal: spacing.md,
              backgroundColor: colors.primary,
              borderRadius: radius.md,
            }}
          >
            <Text style={{ color: colors.primaryForeground, fontSize: fontSize.body }}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
