/**
 * Server-side report aggregates (REPAIR-001 B / REPAIR-002) behind a port, so each
 * database engine provides its own SQL (specs/001-desktop-sqlite-engine S1).
 * Result shapes are exactly those the /reports routes emit today.
 */
export type ByCurrency = Record<string, number>;
export type ReportRow = Record<string, unknown>;

export interface IReportsRepository {
  invoiceTotalsByCurrency(
    tenantId: string,
    type: "sale" | "entry",
    from: string | null,
  ): Promise<{ total: ByCurrency; paid: ByCurrency; remaining: ByCurrency; count: number }>;
  returnTotalsByCurrency(tenantId: string, kind: "sale" | "entry", from: string | null): Promise<{ total: ByCurrency; count: number }>;
  expenseTotalsByCurrency(tenantId: string, from: string | null): Promise<{ total: ByCurrency; count: number }>;
  inventoryValue(tenantId: string): Promise<{ value: ByCurrency; totalKg: number; rollCount: number }>;
  inventoryByFabric(tenantId: string): Promise<Array<{ fabricId: string; name: string; kg: number; rolls: number; value: ByCurrency }>>;
  topFabrics(tenantId: string, from: string | null, limit: number): Promise<Array<{ fabricId: string; name: string; qty: number; revenueByCurrency: ByCurrency }>>;
  topCustomers(
    tenantId: string,
    from: string | null,
    limit: number,
    order: "usdFirst" | "syp",
  ): Promise<Array<{ partyId: string; name: string; revenueByCurrency: ByCurrency }>>;
  ledgerTotalsByCurrency(tenantId: string, from: string | null): Promise<{ debit: ByCurrency; credit: ByCurrency; count: number }>;
  pagedRows(
    tenantId: string,
    slug: string,
    from: string | null,
    page: { page: number; limit: number },
  ): Promise<{ rows: ReportRow[]; total: number } | null>;
  /** Party balances — ledger remaining per currency, raw rows as the route returns them. */
  partyBalances(tenantId: string, kind: string): Promise<ReportRow[]>;
}
