import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { loadReportPage, type ReportPeriod } from "../core/reports";

export function useReport(slug: string, period: ReportPeriod) {
  return useQuery({
    queryKey: ["reports", slug, period],
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? loadReportPage(app.phone, slug, period) : null;
    },
  });
}
