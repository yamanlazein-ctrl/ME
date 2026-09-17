import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { cashboxSessions, manualMovements } from "../orm/schemas/cashbox.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import type { TenantContext } from "../../domain/types/index.js";
import { InsufficientCashboxBalanceError } from "../../domain/errors/index.js";

/**
 * Current cashbox balance for `currency` as of `asOfDate`, computed the same
 * way GET /cashbox/balance/:date and closeDay() do (opening balance + ledger
 * cash movements + manual movements, date-bounded to the session's own
 * opening date for its own currency). Must run inside the caller's
 * transaction (`tx`) so the read is consistent with the write it is guarding.
 */
export async function getCashboxBalanceAsOf(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  asOfDate: string,
): Promise<number> {
  const [session] = await tx
    .select()
    .from(cashboxSessions)
    .where(eq(cashboxSessions.tenantId, ctx.tenantId))
    .limit(1);
  const sessionCurrency = session?.currency;
  const opening = currency === sessionCurrency ? (session?.openingBalance ?? 0) : 0;
  const from = currency === sessionCurrency ? (session?.openingDate ?? "0001-01-01") : "0001-01-01";

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

  return opening + Number(ledger?.amountIn ?? 0) + mIn - Number(ledger?.amountOut ?? 0) - mOut;
}

/**
 * F06 (Phase 1 audit) + product decision: hard-block any cash-out write
 * (manual withdrawal, cash payment voucher) that would take the cashbox
 * balance negative, per-currency. Must be called from INSIDE the caller's
 * transaction, before the write it guards.
 *
 * Serializes per (tenant, currency) with a Postgres transactional advisory
 * lock — the same idiom already used for reference-scoped serialization in
 * PostgresLedgerRepository.cancelByReference — so two concurrent cash-out
 * writes cannot both read the same balance and both pass the check. The
 * second call blocks here until the first transaction commits or rolls back.
 */
export async function assertSufficientCashboxBalance(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  asOfDate: string,
  amount: number,
): Promise<void> {
  const lockKey = `${ctx.tenantId}:cashbox:${currency}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const available = await getCashboxBalanceAsOf(tx, ctx, currency, asOfDate);
  if (available < amount) {
    throw new InsufficientCashboxBalanceError(currency, available, amount);
  }
}
