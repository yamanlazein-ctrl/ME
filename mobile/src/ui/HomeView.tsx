// Home (FR-09, FR-10): what the day needs first — the quick actions this role may use — then today's figures, the cash,
// what customers owe and what we owe (per currency, never combined), and the stock and order alerts that need action.
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "./Text";
import { canWriteOffline, type Role } from "../core/roles";
import type { HomeData } from "../hooks/useDashboard";
import { money } from "./format";
import { radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";
import { ErrorState, KeyValue, ListRow, LoadingState, Screen, Section } from "./kit";

export type HomeAction =
  | "sale"
  | "entry"
  | "receipt"
  | "payment"
  | "expense"
  | "findParty"
  | "inventory"
  | "orders"
  | "sync";

export const HOME_ACTIONS: Array<{
  id: HomeAction;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  write: boolean;
}> = [
  { id: "sale", label: "بيع جديد", icon: "receipt-outline", write: true },
  { id: "receipt", label: "سند قبض", icon: "arrow-down-circle-outline", write: true },
  { id: "entry", label: "فاتورة دخول", icon: "download-outline", write: true },
  { id: "payment", label: "سند صرف", icon: "arrow-up-circle-outline", write: true },
  { id: "expense", label: "مصروف", icon: "wallet-outline", write: true },
  { id: "findParty", label: "بحث عن طرف", icon: "search-outline", write: false },
];

function ActionTile({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress(): void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: "48%",
        minHeight: TOUCH_TARGET + 28,
        padding: spacing.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.muted : colors.card,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
      })}
    >
      <Ionicons name={icon} size={24} color={colors.primary} />
      <Text style={{ fontWeight: "600", flexShrink: 1 }}>{label}</Text>
    </Pressable>
  );
}

function currenciesOf(...maps: Array<Record<string, unknown>>): string[] {
  return [...new Set(maps.flatMap((m) => Object.keys(m)))].sort();
}

export function HomeView({
  data,
  loading,
  error,
  role,
  lastSyncAt,
  refreshing,
  onRefresh,
  onAction,
}: {
  data: HomeData | null | undefined;
  loading: boolean;
  error: unknown;
  role: Role;
  lastSyncAt: string | null;
  refreshing: boolean;
  onRefresh(): void;
  onAction(action: HomeAction): void;
}) {
  const colors = useColors();
  const actions = HOME_ACTIONS.filter((a) => !a.write || canWriteOffline(role));
  const d = data?.dashboard;
  return (
    <Screen
      title={d?.store.name || "الرئيسية"}
      subtitle={lastSyncAt ? `آخر مزامنة: ${lastSyncAt}` : "لم تتم مزامنة بعد"}
      back={false}
      refreshing={refreshing}
      onRefresh={onRefresh}
      testID="home"
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          rowGap: spacing.sm,
        }}
      >
        {actions.map((a) => (
          <ActionTile key={a.id} label={a.label} icon={a.icon} onPress={() => onAction(a.id)} />
        ))}
      </View>
      {!data || !d ? (
        error ? (
          <ErrorState message="تعذّر تحميل الأرقام من قاعدة الهاتف." onRetry={onRefresh} />
        ) : loading ? (
          <LoadingState />
        ) : null
      ) : (
        <>
          <Section title="مبيعات اليوم" testID="today-sales">
            {currenciesOf(d.todaySales.byCurrency).length === 0 ? (
              <Text style={{ color: colors.mutedForeground }}>لا مبيعات اليوم</Text>
            ) : (
              currenciesOf(d.todaySales.byCurrency).map((c) => (
                <KeyValue
                  key={c}
                  label={`${d.todaySales.byCurrency[c]?.count ?? 0} فاتورة`}
                  value={money(d.todaySales.byCurrency[c]?.total ?? 0, c)}
                  strong
                />
              ))
            )}
          </Section>
          <Section title="الصندوق" testID="cashbox-section">
            {currenciesOf(d.cashbox.balanceByCurrency).length === 0 ? (
              <Text style={{ color: colors.mutedForeground }}>لا حركات صندوق</Text>
            ) : (
              currenciesOf(d.cashbox.balanceByCurrency).map((c) => (
                <KeyValue
                  key={c}
                  testID={`cashbox-card-${c}`}
                  label={`الرصيد — ${c}`}
                  value={money(d.cashbox.balanceByCurrency[c] ?? 0, c)}
                  strong
                />
              ))
            )}
          </Section>
          <Section title="الذمم" testID="receivables-payables">
            {currenciesOf(data.receivables, data.payables).length === 0 ? (
              <Text style={{ color: colors.mutedForeground }}>لا ذمم مفتوحة</Text>
            ) : (
              currenciesOf(data.receivables, data.payables).map((c) => (
                <View key={c} style={{ gap: spacing.xs }}>
                  <KeyValue
                    label={`لنا على العملاء — ${c}`}
                    value={money(data.receivables[c] ?? 0, c)}
                  />
                  <KeyValue
                    label={`علينا للموردين — ${c}`}
                    value={money(data.payables[c] ?? 0, c)}
                  />
                </View>
              ))
            )}
          </Section>
          {d.lowStockFabrics > 0 || d.lowStockRolls.outOfStock > 0 || d.outstandingOrders > 0 ? (
            <Section title="تحتاج متابعة" padded={false}>
              {d.lowStockFabrics > 0 ? (
                <ListRow
                  title={`${d.lowStockFabrics} قماش تحت الحد الأدنى`}
                  subtitle={`${d.lowStockRolls.low} صبغة منخفضة · ${d.lowStockRolls.outOfStock} منتهية`}
                  onPress={() => onAction("inventory")}
                />
              ) : null}
              {d.outstandingOrders > 0 ? (
                <ListRow
                  title={`${d.outstandingOrders} طلبية مفتوحة`}
                  onPress={() => onAction("orders")}
                  last
                />
              ) : null}
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}
