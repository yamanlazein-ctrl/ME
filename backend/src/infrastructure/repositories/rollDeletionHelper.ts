import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";
import { stockMovements } from "../orm/schemas/stock-movement.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { printJobs } from "../orm/schemas/print-job.table.js";

/**
 * Clear, user-facing message returned when an inventory master (fabric / color /
 * roll) can't be deleted because it is referenced by live business documents.
 */
export const INVENTORY_DELETE_BLOCKED_MESSAGE =
  "لا يمكن حذف هذا العنصر لارتباطه بمعاملات موجودة (فواتير / طلبيات / مرتجعات / سندات طباعة).";

async function countInvoiceRefs(
  tx: Tx,
  tenantId: string,
  rollIds: string[],
  colorIds: string[],
  fabricId?: string,
): Promise<number> {
  const conds = [];
  if (rollIds.length) conds.push(inArray(invoiceLines.rollId, rollIds));
  if (colorIds.length) conds.push(inArray(invoiceLines.colorId, colorIds));
  if (fabricId) conds.push(eq(invoiceLines.fabricId, fabricId));
  if (conds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invoiceLines)
    .where(and(eq(invoiceLines.tenantId, tenantId), or(...conds)));
  return row?.n ?? 0;
}

async function countOrderRefs(
  tx: Tx,
  tenantId: string,
  rollIds: string[],
  colorIds: string[],
  fabricId?: string,
): Promise<number> {
  const conds = [];
  if (rollIds.length) conds.push(inArray(orderItems.rollId, rollIds));
  if (colorIds.length) conds.push(inArray(orderItems.colorId, colorIds));
  if (fabricId) conds.push(eq(orderItems.fabricId, fabricId));
  if (conds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), or(...conds)));
  return row?.n ?? 0;
}

async function countReturnRefs(tx: Tx, tenantId: string, rollIds: string[]): Promise<number> {
  if (rollIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(returnLines)
    .where(and(eq(returnLines.tenantId, tenantId), inArray(returnLines.rollId, rollIds)));
  return row?.n ?? 0;
}

async function countPrintJobRefs(tx: Tx, tenantId: string, rollIds: string[]): Promise<number> {
  if (rollIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(
      and(
        eq(printJobs.tenantId, tenantId),
        or(inArray(printJobs.sourceRollId, rollIds), inArray(printJobs.resultRollId, rollIds)),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Prepare a set of rolls for deletion inside the caller's transaction.
 *
 * 1. Blocks the whole operation if any of the rolls (or the owning color / fabric,
 *    when supplied) are referenced by live business documents — invoices, orders,
 *    return lines or print jobs. Deleting such masters would corrupt the financial
 *    and inventory audit trail, so a clear business error is thrown instead.
 * 2. Removes the rolls' `stock_movements` rows first. Every roll creation records an
 *    `initial` movement and `stock_movements.roll_id` has NO `ON DELETE CASCADE`, so
 *    failing to clean movements here makes even completely clean deletes throw a
 *    foreign-key violation (which was surfacing as "فشل حذف القماش: مرتبط بمعاملات").
 *
 * The caller is responsible for actually deleting the rolls (and any parent rows).
 */
export async function cleanupRollsForDeletion(opts: {
  tx: Tx;
  ctx: TenantContext;
  rollIds: string[];
  colorIds?: string[];
  fabricId?: string;
}): Promise<void> {
  const { tx, ctx, rollIds, colorIds = [], fabricId } = opts;
  const t = ctx.tenantId;

  const total =
    (await countInvoiceRefs(tx, t, rollIds, colorIds, fabricId)) +
    (await countOrderRefs(tx, t, rollIds, colorIds, fabricId)) +
    (await countReturnRefs(tx, t, rollIds)) +
    (await countPrintJobRefs(tx, t, rollIds));

  if (total > 0) {
    throw new Error(INVENTORY_DELETE_BLOCKED_MESSAGE);
  }

  if (rollIds.length > 0) {
    await tx
      .delete(stockMovements)
      .where(and(inArray(stockMovements.rollId, rollIds), eq(stockMovements.tenantId, t)));
  }
}
