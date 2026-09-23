import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import {
  cashboxDailyBalances,
  cashboxSessions,
  manualMovements,
} from "../orm/schemas/cashbox.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import type { TenantContext } from "../../domain/types/index.js";
import { round2dp } from "@erp/shared";

/**
 * Full recompute of cashbox balance for `currency` as of `asOfDate`
 * (opening + ledger cash legs + manual movements). Used as the source of
 * truth for parity tests and as a fallback when no daily row exists yet.
 */
export async function recomputeCashboxBalanceAsOf(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  asOfDate: string,
): Promise<number> {
  const [session] = await tx
    .select()
    .from(cashboxSessions)
    .where(
      and(eq(cashboxSessions.tenantId, ctx.tenantId), eq(cashboxSessions.currency, currency)),
    )
    .limit(1);
  const opening = session?.openingBalance ?? 0;
  const from = session?.openingDate ?? "0001-01-01";

  const [ledger] = await tx
    .select({
      amountIn: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'in' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
      amountOut: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'out' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenantId),
        eq(ledgerEntries.status, "active"),
        inArray(ledgerEntries.cashImpact, ["in", "out"]),
        eq(ledgerEntries.currency, currency),
        sql`${ledgerEntries.date} >= ${from}`,
        sql`${ledgerEntries.date} <= ${asOfDate}`,
      ),
    );

  const movements = await tx
    .select()
    .from(manualMovements)
    .where(eq(manualMovements.tenantId, ctx.tenantId));
  let mIn = 0;
  let mOut = 0;
  for (const m of movements) {
    if (m.currency !== currency || m.date > asOfDate || m.date < from) continue;
    if (m.direction === "in") mIn += m.amount;
    else mOut += m.amount;
  }

  // Every term is a 2dp decimal; round once so float addition never leaks digits
  // like 4655.879999999999 into the balance (or into the sufficiency guard).
  return round2dp(
    opening + Number(ledger?.amountIn ?? 0) + mIn - Number(ledger?.amountOut ?? 0) - mOut,
  );
}

/**
 * Apply a signed cash delta (+in / -out) to the rolling daily table.
 * Prefer DB triggers for normal writes; call this for opening-balance shifts
 * and tests that seed without going through ledger/manual tables.
 */
export async function applyCashboxDailyDelta(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  date: string,
  signedDelta: number,
): Promise<void> {
  if (!signedDelta) return;
  await tx.execute(
    sql`SELECT cashbox_daily_apply_delta(${ctx.tenantId}::uuid, ${currency}, ${date}::date, ${signedDelta}::numeric)`,
  );
}

/**
 * O(1) balance read from `cashbox_daily_balances` (latest row ≤ asOfDate).
 * Falls back to full recompute when no daily row has been written yet.
 */
export async function getCashboxBalanceAsOf(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  asOfDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ closing: cashboxDailyBalances.closingBalance })
    .from(cashboxDailyBalances)
    .where(
      and(
        eq(cashboxDailyBalances.tenantId, ctx.tenantId),
        eq(cashboxDailyBalances.currency, currency),
        lte(cashboxDailyBalances.balanceDate, asOfDate),
      ),
    )
    .orderBy(desc(cashboxDailyBalances.balanceDate))
    .limit(1);

  if (row) return Number(row.closing);

  // No daily row yet (fresh tenant, or migration just applied without backfill).
  return recomputeCashboxBalanceAsOf(tx, ctx, currency, asOfDate);
}

/**
 * Serializes concurrent cash-out writes per (tenant, currency) so two
 * payments cannot interleave mid-ledger. Negative cash balances are
 * allowed — this is no longer a hard block. Callers may use the returned
 * snapshot to surface a warning in the UI.
 */
export async function assertSufficientCashboxBalance(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  asOfDate: string,
  amount: number,
): Promise<{ available: number; wouldGoNegative: boolean }> {
  if (!(amount > 0)) return { available: 0, wouldGoNegative: false };
  const lockKey = `${ctx.tenantId}:cashbox:${currency}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const available = await getCashboxBalanceAsOf(tx, ctx, currency, asOfDate);
  return { available, wouldGoNegative: available < amount };
}
