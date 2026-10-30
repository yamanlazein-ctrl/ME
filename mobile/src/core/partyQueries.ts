// Party helpers for the phone (FR-11..FR-14): the LIKE pattern, recent-first ordering, and the full statement, which
// pages through `nextCursor` (200 rows per page) to the end, so a long statement is complete.
import type { PartyStatementData, StatementEntryData } from "@backend/domain/entities/Statement";
import type { Phone } from "./phone";

export const STATEMENT_PAGE = 200;
export const MAX_STATEMENT_PAGES = 500;

/** `%` and `_` typed by the user match themselves (same escaping as the desktop's `likeContains`). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Most recently used parties first (from app-state.json), the others keep the search order (FR-11). */
export function sortByRecent<T extends { id: string }>(rows: T[], recentIds: string[]): T[] {
  const rank = new Map(recentIds.map((id, i) => [id, i] as const));
  return [...rows].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

export interface FullStatement {
  header: Omit<PartyStatementData, "entries" | "page">;
  entries: StatementEntryData[];
}

export async function loadFullStatement(
  phone: Phone,
  query: {
    partyId: string;
    kind: "customer" | "supplier";
    currency?: string;
    from?: string;
    to?: string;
  },
): Promise<FullStatement> {
  const entries: StatementEntryData[] = [];
  let cursor: string | undefined;
  let header: FullStatement["header"] | null = null;
  for (let page = 0; page < MAX_STATEMENT_PAGES; page++) {
    const data = await phone.repos.statementRepo.getStatement(
      {
        partyId: query.partyId,
        kind: query.kind,
        ...(query.currency ? { currency: query.currency } : {}),
        ...(query.from ? { fromDate: query.from } : {}),
        ...(query.to ? { toDate: query.to } : {}),
        limit: STATEMENT_PAGE,
        ...(cursor ? { cursor } : {}),
      } as never,
      phone.context(),
    );
    const { entries: pageEntries, page: pageInfo, ...rest } = data;
    header ??= rest;
    entries.push(...pageEntries);
    if (!pageInfo?.hasMore || !pageInfo.nextCursor) break;
    cursor = pageInfo.nextCursor;
  }
  if (!header) throw new Error("لا يوجد كشف حساب");
  return { header, entries };
}
