import { useState } from "react";
import { ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { ReportPeriod } from "../../../../src/core/reports";
import { useReport } from "../../../../src/hooks/useReport";
import { ReportPageView } from "../../../../src/ui/ReportViews";

export default function ReportScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [period, setPeriod] = useState<ReportPeriod>("all");
  const { data, error, isLoading } = useReport(slug, period);
  if (isLoading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!data) {
    return (
      <ReportPageView
        page={{ slug, title: "تقرير", figures: [], lines: [], total: 0 }}
        period={period}
        error={error ? String(error) : "التقرير غير موجود"}
        onPeriod={setPeriod}
      />
    );
  }
  return (
    <ReportPageView
      page={data}
      period={period}
      error={error ? String(error) : null}
      onPeriod={setPeriod}
    />
  );
}
