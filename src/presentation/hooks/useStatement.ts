import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

type StatementPage = {
  entries: unknown[];
  page?: { hasMore: boolean; nextCursor: string | null } & Record<string, unknown>;
};

/**
 * Return the COMPLETE statement for a filter. The server caps a page (200/500
 * rows) and carries runningBalance across pages, so following nextCursor and
 * concatenating entries is exact; header totals / previous / final balance
 * are full-window values from the first page. An explicit cursor means the
 * caller pages itself. (Before: rows past 200 silently vanished from the
 * screen and from the printed statement.)
 */
export async function fetchFullStatement<T extends StatementPage>(
  getPage: (f: StatementFilter) => Promise<T>,
  filter: StatementFilter,
): Promise<T> {
  const first = await getPage(filter);
  if (filter.cursor) return first;
  let page = first.page;
  const entries = [...first.entries];
  for (let i = 0; page?.hasMore && page.nextCursor && i < 1000; i++) {
    const next = await getPage({ ...filter, limit: 500, cursor: page.nextCursor });
    entries.push(...next.entries);
    page = next.page;
  }
  return {
    ...first,
    entries,
    page: first.page && { ...first.page, hasMore: false, nextCursor: null },
  } as T;
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
    queryFn: async ({ signal }) => {
      void signal;
      return fetchFullStatement(
        (f) => container.statement.api.getStatement(partyId ?? "", kind, f),
        normalized,
      );
    },
    enabled: !!partyId,
    staleTime: 15_000,
  });
}

/**
 * ONE screen page of the statement (20/50/100 rows). The server computes the
 * carried balance («رصيد منقول») of the rows before the page, so page N opens
 * with exactly the balance page N-1 closed on — rendering thousands of rows
 * at once is what froze the statement screen.
 */
export function useStatementPage(
  partyId: string | undefined,
  kind: PartyKind,
  filter: StatementFilter,
  page: number,
  pageSize: number,
) {
  const normalized = { ...normalizeFilter(filter), limit: pageSize, cursor: undefined, page };
  return useQuery({
    queryKey: [...KEYS.party(partyId ?? "", kind, normalized), "page"] as const,
    queryFn: () => container.statement.api.getStatement(partyId ?? "", kind, normalized),
    enabled: !!partyId,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/** The COMPLETE statement, fetched on demand (print / Excel export). */
export function loadFullStatement(partyId: string, kind: PartyKind, filter: StatementFilter) {
  return fetchFullStatement(
    (f) => container.statement.api.getStatement(partyId, kind, f),
    { ...normalizeFilter(filter), limit: 500, cursor: undefined },
  );
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
