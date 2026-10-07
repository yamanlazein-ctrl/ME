import { and, eq } from "drizzle-orm";
import { engineSchema } from "../orm/engineSchema.js";
import { logger } from "../config/logger.js";

/**
 * A financial year's status is tenant-wide and the hub owns it: a year closed on one
 * device must refuse writes on every device. Paired devices close/reopen through the
 * hub, then adopt its status here; every sync cycle re-adopts the hub's list.
 * Only the freeze state is mirrored — the closing figures live on the hub.
 */
export async function adoptYearStatus(
  tx: unknown,
  tenantId: string,
  year: number,
  status: string,
  closedAt: Date | null,
): Promise<boolean> {
  if (status !== "open" && status !== "closed") return false;
  const { financialYears } = await engineSchema();
  const db = tx as import("../orm/drizzle.js").DB;
  const where = and(eq(financialYears.tenantId, tenantId), eq(financialYears.year, year));
  const [row] = await db
    .select({ status: financialYears.status })
    .from(financialYears)
    .where(where)
    .limit(1);
  if ((row?.status ?? "open") === status || (row?.status === "counting" && status === "open"))
    return false;
  const now = new Date();
  if (row) {
    await db
      .update(financialYears)
      .set(
        status === "closed"
          ? { status, closedAt: closedAt ?? now, updatedAt: now }
          : { status, reopenedAt: now, updatedAt: now },
      )
      .where(where);
  } else {
    await db.insert(financialYears).values({
      tenantId,
      year,
      status,
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      closedAt: closedAt ?? now,
    } as never);
  }
  logger.info({ tenantId, year, status }, "financial year status adopted from the hub");
  return true;
}
