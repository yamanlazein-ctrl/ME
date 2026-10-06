import { container } from "@/infrastructure/container";

/**
 * Client for the corrective dye (fabric) cascade endpoints.
 *
 * Shared by the confirmation dialog and the bulk-delete path so both go through
 * exactly one implementation. Fabric deletion is a FINANCIAL operation — it can
 * cascade into invoices, vouchers, ledger entries and the cashbox — so it must
 * never fall back to the plain `DELETE /inventory/fabrics/:id` route, which
 * refuses to touch a fabric that has live documents and would otherwise leave
 * the operator with a half-finished job.
 */

export type DyeImpact = {
  fabricId: string;
  fabricName: string | null;
  colorsCount: number;
  rollsCount: number;
  stockMovementsCount: number;
  ledgerEntriesCount: number;
  vouchersCount: number;
  otherBlocked: string[];
  affectedInvoices: { id: string; number: string; type: string; total: number }[];
  cashDelta: { syp: number; usd: number };
  affectedCurrencies: string[];
  earliestDate: string | null;
};

export type DyePurgeResult = {
  fabricId: string;
  colorsDeleted: number;
  rollsDeleted: number;
  stockMovementsDeleted: number;
  invoicesDeleted: number;
  invoiceLinesDeleted: number;
  ledgerEntriesDeleted: number;
  vouchersDeleted: number;
  cashDelta: { syp: number; usd: number };
  currenciesRebuilt: string[];
};

/** Operator must retype either this word or the fabric's own name. */
export const CONFIRM_WORD = "تأكيد";

/** Read-only dry run: what a purge WOULD remove. Writes nothing. */
export async function fetchDyeImpact(fabricId: string): Promise<DyeImpact> {
  const res = await container.http.get<DyeImpact>(
    `/api/inventory/dyes/${fabricId}/deletion-impact`,
  );
  return res.data;
}

/** The purge. One server-side transaction; throws and rolls back on any failure. */
export async function purgeDye(
  fabricId: string,
  confirmation: string,
  reason?: string,
): Promise<DyePurgeResult> {
  const res = await container.http.delete<DyePurgeResult>(
    `/api/inventory/dyes/${fabricId}/purge`,
    { body: { confirmation: confirmation.trim(), ...(reason ? { reason } : {}) } },
  );
  return res.data;
}
