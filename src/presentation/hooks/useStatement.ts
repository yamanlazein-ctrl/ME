import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { toast } from "sonner";
import type { Currency } from "@/domain/types";
import type { PartyKind } from "@/domain/entities/Party";
import type { StatementFilter, SettleInvoicesInput } from "@/contracts/statement";

/**
 * Party statement (كشف حساب) hooks.
 *
 * The statement is computed server-side (previous balance, chronological rows,
 * running balances, invoice line details, totals) — the UI just renders it.
 */
const KEYS = {
  root: ["statement"] as const,
  party: (partyId: string, kind: PartyKind, filter: StatementFilter) =>
    ["statement", partyId, kind, filter] as const,
};

function normalizeFilter(filter: StatementFilter): StatementFilter {
  return {
    from: filter.from || undefined,
    to: filter.to || undefined,
    currency: filter.currency || undefined,
    type: filter.type || undefined,
    limit: filter.limit ?? 200,
    cursor: filter.cursor || undefined,
  };
}

/** Fetch the statement for a party, optionally windowed by date/currency/type. */
export function useStatement(
  partyId: string | undefined,
  kind: PartyKind,
  filter: StatementFilter = {},
) {
  const normalized = normalizeFilter(filter);
  return useQuery({
    queryKey: KEYS.party(partyId ?? "", kind, normalized),
    queryFn: ({ signal }) => {
      void signal;
      return container.statement.api.getStatement(partyId ?? "", kind, normalized);
    },
    enabled: !!partyId,
    staleTime: 15_000,
  });
}

function invalidateAfterSettlement(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEYS.root });
  qc.invalidateQueries({ queryKey: ["ledger"] });
  qc.invalidateQueries({ queryKey: ["parties"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["invoices"] });
  qc.invalidateQueries({ queryKey: ["vouchers"] });
  qc.invalidateQueries({ queryKey: ["returns"] });
  qc.invalidateQueries({ queryKey: ["cashbox"] });
}

export function useSettleParty(partyId: string | undefined, kind: PartyKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input?: { date?: string; currency?: Currency; notesInternal?: string }) => {
      try {
        const res = await container.statement.api.settle(partyId ?? "", kind, input);
        return { ok: true as const, referenceNumber: res.referenceNumber };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "فشل تسجيل الدفعة";
        return { ok: false as const, error: msg };
      }
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(`تم تسجيل الدفعة (${res.referenceNumber})`);
        invalidateAfterSettlement(qc);
      } else {
        toast.error(res.error);
      }
    },
  });
}

/** Multi-invoice cash settlement (سند دفعة مجمّع لعدة فواتير). */
export function useSettleInvoices(partyId: string | undefined, kind: PartyKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SettleInvoicesInput) =>
      container.statement.api.settleInvoices(partyId ?? "", kind, input),
    onSuccess: (res) => {
      toast.success(`تم تسجيل الدفعة (${res.batchNumber})`);
      invalidateAfterSettlement(qc);
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "فشل تسجيل الدفعة");
    },
  });
}
