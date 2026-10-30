import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { MENU, type ReportPeriod } from "../../../../src/core/reports";
import { useReport } from "../../../../src/hooks/useReport";
import { readErrorText } from "../../../../src/ui/kit";
import { ReportPageView } from "../../../../src/ui/ReportViews";

export default function ReportScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [period, setPeriod] = useState<ReportPeriod>("all");
  const report = useReport(slug, period);
  return (
    <ReportPageView
      page={report.data}
      title={MENU.find((m) => m.slug === slug)?.title ?? "تقرير"}
      period={period}
      loading={report.isLoading}
      error={report.error ? readErrorText(report.error) : null}
      onPeriod={setPeriod}
      onRetry={() => void report.refetch()}
    />
  );
}
