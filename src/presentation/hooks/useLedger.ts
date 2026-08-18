import { useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import type { LedgerFilter } from "@/application/ports";

const ctx = buildTenantContext();

const KEYS = {
  root: ["ledger"] as const,
  entries: (f?: LedgerFilter) => ["ledger", "entries", f ?? {}] as const,
  balance: (partyId: string, currency?: string) =>
    ["ledger", "balance", partyId, currency ?? "SYP"] as const,
  cashMovements: (date: string, currency?: string) =>
    ["ledger", "cashMovements", date, currency ?? "SYP"] as const,
};

export function useLedgerEntries(filter?: LedgerFilter) {
  return useQuery({
    queryKey: KEYS.entries(filter),
    queryFn: ({ signal }) => {
      void signal;
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
  partyOf,
} from "@/core/calculations/ledgerCalc";

// Legacy re-export (deprecated — will be removed)
export function useLedger() {}
export const ledgerEntries: unknown[] = [];
export function writeLedger() {}
export function cancelLedgerByRef() {}
