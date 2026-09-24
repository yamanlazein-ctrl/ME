import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { fetchAllPaged } from "@/lib/fetchAllPaged";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import type { LedgerFilter } from "@/application/ports";

const ctx = new Proxy({} as import("@/domain/types").TenantContext, {
  get: (_target, property: string) =>
    buildTenantContext()[property as keyof import("@/domain/types").TenantContext],
});

const KEYS = {
  root: ["ledger"] as const,
  entries: (f?: LedgerFilter) => ["ledger", "entries", f ?? {}] as const,
  balance: (partyId: string, currency?: string) =>
    ["ledger", "balance", partyId, currency ?? "SYP"] as const,
  cashMovements: (date: string, currency?: string) =>
    ["ledger", "cashMovements", date, currency ?? "SYP"] as const,
};

/**
 * `opts.all`: page through the API (page/limit, 1000 per page) and return
 * EVERY matching row — for screens that compute balances/totals and must not
 * work on a truncated first page.
 */
/**
 * One server page of ledger entries with the total count — for the central
 * ledger screen (filters run in SQL; the full history is never downloaded).
 */
export function useLedgerPage(filter: LedgerFilter) {
  return useQuery({
    queryKey: [...KEYS.entries(filter), "page"],
    queryFn: ({ signal }) => {
      void signal;
      return container.invoices.ledger.entries(filter, ctx);
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useLedgerEntries(filter?: LedgerFilter, opts?: { all?: boolean }) {
  const all = Boolean(opts?.all);
  return useQuery({
    queryKey: all ? [...KEYS.entries(filter), "all"] : KEYS.entries(filter),
    queryFn: async ({ signal }) => {
      void signal;
      if (all) {
        const data = await fetchAllPaged(
          (page, limit, cursor) =>
            container.invoices.ledger.entries(
              { ...(filter ?? {}), page, limit, cursor } as LedgerFilter,
              ctx,
            ),
          { pageSize: 1000, maxPages: 500, label: "ledger" },
        );
        return { data, total: data.length, hasNext: false };
      }
      return container.invoices.ledger.entries(filter ?? {}, ctx);
    },
    select: (result) => result.data,
    staleTime: 30_000,
  });
}

export function useLedgerBalance(partyId: string, currency: string = "SYP") {
  return useQuery({
    queryKey: KEYS.balance(partyId, currency),
    queryFn: ({ signal }) => {
      void signal;
      return container.invoices.ledger.balance(partyId, currency, ctx);
    },
    enabled: !!partyId,
    staleTime: 30_000,
  });
}

export function useCashMovementsOn(date: string, currency: string = "SYP") {
  return useQuery({
    queryKey: KEYS.cashMovements(date, currency),
    queryFn: ({ signal }) => {
      void signal;
      return container.invoices.ledger.cashMovementsOn(date, currency, ctx);
    },
    enabled: !!date,
    staleTime: 30_000,
  });
}

export {
  type LedgerType,
  type CashImpact,
  type LedgerStatus,
  type LedgerEntry,
  LEDGER_TYPE_LABEL,
  filterLedger,
  buildLedger,
  buildGlobalLedger,
  buildFabricHistory,
  buildOutstanding,
  buildPartyStats,
  buildPartyStatsByCurrency,
  ledgerRemainingByCurrency,
  partyOf,
} from "@/core/calculations/ledgerCalc";

// Legacy re-export (deprecated — will be removed)
export function useLedger() {}
export const ledgerEntries: unknown[] = [];
export function writeLedger() {}
export function cancelLedgerByRef() {}
