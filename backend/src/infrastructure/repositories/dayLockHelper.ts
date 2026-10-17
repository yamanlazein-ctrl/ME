import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { dayCloses } from "../orm/schemas/cashbox.table.js";
import { financialYears } from "../orm/schemas/financial-year.table.js";
import { DayLockedError } from "../../domain/errors/index.js";

/**
 * Reject cashbox writes on a day that has been closed (a `day_closes` row for
 * that tenant+date+currency exists). Must run INSIDE the caller's transaction
 * so the lock check and the write are atomic (no TOCTOU race with a concurrent
 * close-day).
 *
 * Enforced for manual cashbox movements, vouchers (receipts/payments) and cash
 * expenses — the day-lock otherwise had no effect on same-day writes.
 *
 * The YEAR check runs here too, on purpose: every one of those write paths
 * already calls this helper, so the year freeze covers them without touching a
 * single call site. A closed financial year rejects writes exactly like a
 * closed day does, and the operator sees the same clear message.
 *
 * Day closure is per currency: closing the SYP day does not lock the USD day
 * and vice versa. `currency` is part of the advisory lock key so concurrent
 * closes of the same tenant+date+currency serialize.
 */
export async function assertDayUnlocked(
  tx: Tx,
  tenantId: string,
  date: string,
  currency: string,
): Promise<void> {
  // H-08: a plain READ COMMITTED read is not atomic with a concurrent close — the writer could pass,
  // the close commit, then the write commit after the close snapshot. Writers hold this key SHARED
  // (they never block each other); closeDay holds it EXCLUSIVE, so a close waits for in-flight
  // writers and a writer that waited re-reads the committed close below.
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`${tenantId}:day:${date}:${currency}`}, 0))`,
  );
  const [row] = await tx
    .select({ id: dayCloses.id })
    .from(dayCloses)
    .where(
      and(
        eq(dayCloses.tenantId, tenantId),
        eq(dayCloses.date, date),
        eq(dayCloses.currency, currency),
      ),
    )
    .limit(1);
  if (row) throw new DayLockedError(`${date} (${currency})`);

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
 * write are atomic against a concurrent close: this path holds the close's
 * advisory key in SHARED mode (H-08 — it used to only read, so it was not).
 */
export async function assertYearOpen(tx: Tx, tenantId: string, date: string): Promise<void> {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return;
  // H-08: shared side of `lockYear` (exclusive, taken by close/reopen) — see assertDayUnlocked.
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`${tenantId}:year:${year}`}, 0))`,
  );

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
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:year:${year}`}, 0))`,
  );
}

/** Exclusive side of the day key `assertDayUnlocked` holds shared: serializes a day close against writers. */
export async function lockDay(
  tx: Tx,
  tenantId: string,
  date: string,
  currency: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:day:${date}:${currency}`}, 0))`,
  );
}
