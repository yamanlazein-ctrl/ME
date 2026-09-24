import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";

/**
 * Server-side report aggregates. The report screens used to download every
 * invoice/return/expense/ledger row and sum them in the browser; at 100k
 * documents that froze the UI. The server now runs the SAME formulas in SQL
 * (backend reportAggregates.ts, parity-tested) and returns totals + paged rows.
 */
export type ByCurrency = Record<string, number>;

export type ReportSummary = {
  from: string | null;
  sales: ByCurrency;
  purchases: ByCurrency;
  salesReturns: ByCurrency;
  entryReturns: ByCurrency;
  expenses: ByCurrency;
  inventoryValue: ByCurrency;
  totalKg: number;
  rollCount: number;
  topFabrics: Array<{ fabricId: string; name: string; qty: number; revenueByCurrency: ByCurrency }>;
  topCustomers: Array<{ partyId: string; name: string; revenueByCurrency: ByCurrency }>;
};

export type ReportDetail<R = Record<string, unknown>> = {
  summary: Record<string, unknown>;
  rows: R[];
  meta: { total: number; page: number; limit: number; hasNext: boolean };
};

const KEYS = {
  summary: (from: string | null) => ["reports", "summary", from ?? "all"] as const,
  detail: (slug: string, from: string | null, page: number, limit: number) =>
    ["reports", "detail", slug, from ?? "all", page, limit] as const,
};

export function useReportSummary(from: string | null) {
  return useQuery({
    queryKey: KEYS.summary(from),
    queryFn: async () => {
      const res = await container.http.get<ReportSummary>("/api/reports/summary", {
        params: from ? { from } : {},
      });
      return res.data;
    },
    staleTime: 30_000,
  });
}

export function useReportDetail<R = Record<string, unknown>>(
  slug: string,
  from: string | null,
  page: number,
  limit = 100,
) {
  return useQuery({
    queryKey: KEYS.detail(slug, from, page, limit),
    queryFn: async () => {
      const res = await container.http.get<ReportDetail<R>>(
        `/api/reports/detail/${encodeURIComponent(slug)}`,
        { params: { ...(from ? { from } : {}), page: String(page), limit: String(limit) } },
      );
      return res.data;
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
