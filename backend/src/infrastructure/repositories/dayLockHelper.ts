import { and, eq } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { dayCloses } from "../orm/schemas/cashbox.table.js";
import { DayLockedError } from "../../domain/errors/index.js";

/**
 * Reject cashbox writes on a day that has been closed (a `day_closes` row for
 * that tenant+date exists). Must run INSIDE the caller's transaction so the
 * lock check and the write are atomic (no TOCTOU race with a concurrent
 * close-day).
 *
 * Enforced for manual cashbox movements, vouchers (receipts/payments) and cash
 * expenses — the day-lock otherwise had no effect on same-day writes.
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
}