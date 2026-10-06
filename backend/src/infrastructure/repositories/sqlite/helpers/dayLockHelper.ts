// PORTED-FROM: src/infrastructure/repositories/dayLockHelper.ts sha256=9900b5bc6e8f7811e6c198d116aae37a60b9ad950c23a951151a2c9ab9dedc41
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../../orm/sqlite/drizzleCompat.js";
import { dayCloses } from "../../../orm/sqlite/schemas/cashbox.table.js";
import { financialYears } from "../../../orm/sqlite/schemas/financial-year.table.js";
import { DayLockedError } from "../../../../domain/errors/index.js";

/**
 * Reject cashbox writes on a day that has been closed (a `day_closes` row for
 * that tenant+date exists). Must run INSIDE the caller's transaction so the
 * lock check and the write are atomic (no TOCTOU race with a concurrent
 * close-day).
 *
 * Enforced for manual cashbox movements, vouchers (receipts/payments) and cash
 * expenses — the day-lock otherwise had no effect on same-day writes.
 *
 * The YEAR check runs here too, on purpose: every one of those write paths
 * already calls this helper, so the year freeze covers them without touching a
 * single call site. A closed financial year rejects writes exactly like a
 * closed day does, and the operator sees the same clear message.
 */
export async function assertDayUnlocked(
  tx: Tx,
  tenantId: string,
  date: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: dayCloses.id })
    .from(dayCloses)
    .where(and(eq(dayCloses.tenantId, tenantId), eq(dayCloses.date, date)))
    .limit(1);
  if (row) throw new DayLockedError(date);

  await assertYearOpen(tx, tenantId, date);
}

/**
 * Year-end closing guard — the annual counterpart of `assertDayUnlocked`.
 *
 * A closed financial year is FROZEN: no invoice, voucher, stock movement,
 * expense or manual cashbox movement may be written with a date inside it.
 * Reopen (admin-only, audited) is the only way out, and it clears the flag
 * rather than editing history.
 *
 * Reuses `DayLockedError` so the existing error mapping renders it in the UI
 * without a new branch.
 *
 * The lookup is a single indexed read on `financial_years(tenant_id, year)`,
 * and callers already run inside the write transaction, so the check and the
 * write are atomic against a concurrent close (which takes the same advisory
 * lock this path does).
 */
export async function assertYearOpen(tx: Tx, tenantId: string, date: string): Promise<void> {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return;

  const [row] = await tx
    .select({ year: financialYears.year })
    .from(financialYears)
    .where(
      and(
        eq(financialYears.tenantId, tenantId),
        eq(financialYears.year, year),
        eq(financialYears.status, "closed"),
      ),
    )
    .limit(1);
  if (row) throw new DayLockedError(`${year}`);
}

/**
 * Serialize year-end closing per (tenant, year) so two operators clicking
 * "close" at the same instant cannot interleave. The second one blocks on the
 * first, then re-reads and sees `status = 'closed'` and is rejected — no
 * double close, no partial close.
 */
export async function lockYear(tx: Tx, tenantId: string, year: number): Promise<void> {
  // PG: pg_advisory_xact_lock(tenant:year). SQLite: the write gate already serializes every writer.
  void tx;
  void tenantId;
  void year;
}