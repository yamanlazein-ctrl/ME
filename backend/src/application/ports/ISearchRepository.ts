/**
 * Server-side typeahead search (REPAIR-001 A), behind a port so each database
 * engine provides its own implementation (specs/001-desktop-sqlite-engine S1).
 *
 * Rows are returned exactly as the HTTP endpoints emit them (column aliases and
 * value types included), so the routes stay a thin pass-through.
 */
export type SearchRow = Record<string, unknown>;

export interface PartySearchInput {
  tenantId: string;
  q: string;
  kind: string;
  status: string;
  limit: number;
  pattern: string;
  cursor: { sortKey: string; id: string } | null;
}

export interface ISearchRepository {
  /** Returns up to `limit + 1` rows (the extra row signals another page). */
  searchParties(input: PartySearchInput): Promise<SearchRow[]>;
  searchFabrics(tenantId: string, q: string, pattern: string, limit: number): Promise<SearchRow[]>;
  searchColors(tenantId: string, fabricId: string, pattern: string, limit: number): Promise<SearchRow[]>;
  searchRolls(tenantId: string, colorId: string, status: string, pattern: string, limit: number): Promise<SearchRow[]>;
  partiesByIds(tenantId: string, ids: string[]): Promise<SearchRow[]>;
  rollsByIds(tenantId: string, ids: string[]): Promise<SearchRow[]>;
}
