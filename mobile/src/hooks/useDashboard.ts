// Home figures from the same dashboard use-case the desktop calls, through the phone's repositories (FR-09). Receivables and
// payables come from the same party-balance query the desktop reports use, summed per currency (never across currencies).
import { useQuery } from "@tanstack/react-query";
import { round2dp } from "@erp/shared";
import { getDashboardUseCase } from "@backend/application/use-cases/dashboard/dashboardUseCases";
import type { DashboardData } from "@backend/domain/entities/Dashboard";
import { getApp } from "../core/appRuntime";
import { logError } from "../core/devlog";
import type { Phone } from "../core/phone";
import { queryKeys } from "./queryKeys";

export interface HomeData {
  dashboard: DashboardData;
  receivables: Record<string, number>;
  payables: Record<string, number>;
}

function sumByCurrency(rows: Array<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const currency = typeof r.currency === "string" ? r.currency : null;
    if (!currency) continue;
    out[currency] = round2dp((out[currency] ?? 0) + Number(r.remaining ?? 0));
  }
  return out;
}

export async function loadDashboard(phone: Phone): Promise<HomeData> {
  const result = await getDashboardUseCase(phone.repos.dashboardRepo, phone.context());
  if (!result.ok) throw new Error(result.error);
  const tenantId = phone.identity.tenantId;
  const receivables = await phone.repos.reportsRepo.partyBalances(tenantId, "customer");
  const payables = await phone.repos.reportsRepo.partyBalances(tenantId, "supplier");
  return {
    dashboard: result.data,
    receivables: sumByCurrency(receivables as Array<Record<string, unknown>>),
    payables: sumByCurrency(payables as Array<Record<string, unknown>>),
  };
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: async () => {
      try {
        const app = await getApp();
        if (!app.phone) return null; // not enrolled yet: nothing to show, not an error
        return await loadDashboard(app.phone);
      } catch (error) {
        logError("home", error);
        throw error;
      }
    },
  });
}
