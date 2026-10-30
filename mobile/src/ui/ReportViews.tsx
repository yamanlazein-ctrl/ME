// Report screens (FR-28): the report list, and one page for any report: a period filter, the period's figures per currency
// and the rows. Currencies are never combined: every amount carries its own currency.
import { View } from "react-native";
import { Text } from "./Text";
import {
  MENU,
  PERIOD_LABEL,
  type ReportAmount,
  type ReportPage,
  type ReportPeriod,
} from "../core/reports";
import { money } from "./format";
import { useColors } from "./themeContext-core";
import { Chips, EmptyState, ErrorState, ListRow, LoadingState, Screen, Section } from "./kit";

export function ReportMenuView({ onOpen }: { onOpen(slug: string): void }) {
  return (
    <Screen title="التقارير" subtitle={`${MENU.length} تقريراً`}>
      <Section padded={false}>
        {MENU.map((m, i) => (
          <ListRow
            key={m.slug}
            testID={`report-${m.slug}`}
            title={m.title}
            onPress={() => onOpen(m.slug)}
            last={i === MENU.length - 1}
          />
        ))}
      </Section>
    </Screen>
  );
}

function Amounts({ amounts, strong = false }: { amounts: ReportAmount[]; strong?: boolean }) {
  const colors = useColors();
  if (amounts.length === 0) return <Text style={{ color: colors.mutedForeground }}>—</Text>;
  return (
    <View style={{ alignItems: "flex-end" }}>
      {amounts.map((a) => (
        <Text
          key={a.currency}
          style={{
            fontWeight: strong ? "700" : "600",
            writingDirection: "ltr",
            color: a.amount < 0 ? colors.negative : colors.foreground,
          }}
        >
          {money(a.amount, a.currency)}
        </Text>
      ))}
    </View>
  );
}

export const PERIOD_OPTIONS = (Object.keys(PERIOD_LABEL) as ReportPeriod[]).map((p) => ({
  value: p,
  label: PERIOD_LABEL[p],
}));

export function ReportPageView({
  page,
  title,
  period,
  loading,
  error,
  onPeriod,
  onRetry,
}: {
  page: ReportPage | null | undefined;
  title: string;
  period: ReportPeriod;
  loading: boolean;
  error: string | null;
  onPeriod(p: ReportPeriod): void;
  onRetry(): void;
}) {
  const colors = useColors();
  return (
    <Screen title={page?.title ?? title} subtitle={PERIOD_LABEL[period]}>
      <Chips<ReportPeriod>
        options={PERIOD_OPTIONS}
        value={period}
        onChange={onPeriod}
        testIDPrefix="period"
      />
      {error && !page ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading && !page ? (
        <LoadingState />
      ) : page ? (
        <>
          {page.figures.length > 0 ? (
            <Section title="الملخص" testID="report-figures">
              {page.figures.map((f) => (
                <View
                  key={f.label}
                  style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
                >
                  <Text style={{ color: colors.mutedForeground, flexShrink: 1 }}>{f.label}</Text>
                  {f.plain ? (
                    <Text style={{ fontWeight: "700" }}>{f.plain}</Text>
                  ) : (
                    <Amounts amounts={f.amounts} strong />
                  )}
                </View>
              ))}
            </Section>
          ) : null}
          {page.lines.length === 0 ? (
            <View testID="report-empty">
              <EmptyState title="لا بيانات في هذه الفترة" icon="bar-chart-outline" />
            </View>
          ) : (
            <Section title={`التفاصيل (${page.lines.length})`} padded={false}>
              {page.lines.map((item, i) => (
                <ListRow
                  key={`${item.id}-${i}`}
                  testID="report-line"
                  title={item.title}
                  subtitle={item.subtitle ?? null}
                  value={<Amounts amounts={item.amounts} />}
                  last={i === page.lines.length - 1}
                />
              ))}
            </Section>
          )}
        </>
      ) : (
        <EmptyState title="التقرير غير موجود" />
      )}
    </Screen>
  );
}
