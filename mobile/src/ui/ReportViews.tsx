// Report screens' views (FR-28): the report list, and one page for any report: a period filter, the full-period figures per
// currency and the rows. Currencies are never combined: every amount carries its own currency.
import { FlatList, Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import {
  MENU,
  PERIOD_LABEL,
  type ReportAmount,
  type ReportPage,
  type ReportPeriod,
} from "../core/reports";
import { MoneyText } from "./MoneyText";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export function ReportMenuView({ onOpen }: { onOpen(slug: string): void }) {
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.lg }}>التقارير</Text>
      <FlatList
        data={MENU}
        keyExtractor={(m) => m.slug}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() => onOpen(item.slug)}
            style={{
              minHeight: TOUCH_TARGET,
              justifyContent: "center",
              padding: spacing.lg,
              marginBottom: spacing.sm,
              backgroundColor: colors.card,
              borderRadius: radius.md,
            }}
          >
            <Text style={{ fontSize: fontSize.body }}>{item.title}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function Amounts({ amounts }: { amounts: ReportAmount[] }) {
  if (amounts.length === 0) return <Text style={{ color: colors.mutedForeground }}>—</Text>;
  return (
    <View>
      {amounts.map((a) => (
        <MoneyText key={a.currency} amount={a.amount} currency={a.currency} />
      ))}
    </View>
  );
}

export function PeriodChips({
  period,
  onChange,
}: {
  period: ReportPeriod;
  onChange(p: ReportPeriod): void;
}) {
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md }}
    >
      {(Object.keys(PERIOD_LABEL) as ReportPeriod[]).map((p) => (
        <Pressable
          key={p}
          accessibilityRole="button"
          accessibilityState={{ selected: period === p }}
          onPress={() => onChange(p)}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            paddingHorizontal: spacing.lg,
            borderRadius: radius.xl,
            backgroundColor: period === p ? colors.primary : colors.muted,
          }}
        >
          <Text style={{ color: period === p ? colors.primaryForeground : colors.foreground }}>
            {PERIOD_LABEL[p]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ReportPageView({
  page,
  period,
  error,
  onPeriod,
}: {
  page: ReportPage;
  period: ReportPeriod;
  error: string | null;
  onPeriod(p: ReportPeriod): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>{page.title}</Text>
      <PeriodChips period={period} onChange={onPeriod} />
      {error ? (
        <Text testID="report-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      <ScrollView>
        <View testID="report-figures">
          {page.figures.map((f) => (
            <View
              key={f.label}
              style={{
                padding: spacing.md,
                marginBottom: spacing.sm,
                backgroundColor: colors.card,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Text style={{ color: colors.mutedForeground }}>{f.label}</Text>
              {f.plain ? <Text>{f.plain}</Text> : <Amounts amounts={f.amounts} />}
            </View>
          ))}
        </View>
        {page.lines.length === 0 ? (
          <Text testID="report-empty">لا بيانات في هذه الفترة</Text>
        ) : null}
        {page.lines.map((item, i) => (
          <View
            key={`${item.id}-${i}`}
            testID="report-line"
            style={{
              paddingVertical: spacing.sm,
              borderBottomWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text>{item.title}</Text>
            {item.subtitle ? (
              <Text style={{ color: colors.mutedForeground }}>{item.subtitle}</Text>
            ) : null}
            <Amounts amounts={item.amounts} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
