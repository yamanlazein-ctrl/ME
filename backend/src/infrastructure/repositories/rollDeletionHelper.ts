import { and, eq, inArray, or, sql, desc } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";
import { stockMovements } from "../orm/schemas/stock-movement.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { orders } from "../orm/schemas/order.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { printJobs } from "../orm/schemas/print-job.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";

/**
 * Clear, user-facing message returned when an inventory master (fabric / color /
 * roll) can't be deleted because it is referenced by live business documents.
 */
export const INVENTORY_DELETE_BLOCKED_MESSAGE =
  "لا يمكن حذف هذا العنصر لارتباطه بمعاملات موجودة (فواتير / طلبيات / مرتجعات / سندات طباعة).";

export type ColorDeletionRef = {
  kind: "invoice" | "order" | "return" | "print_job" | "roll" | "stock_movement";
  id: string;
  label: string;
};

export type ColorDeletionImpact = {
  colorId: string;
  colorName: string | null;
  rollsCount: number;
  stockMovementsCount: number;
  invoiceRefs: ColorDeletionRef[];
  orderRefs: ColorDeletionRef[];
  returnRefs: ColorDeletionRef[];
  printJobRefs: ColorDeletionRef[];
  /** True when only rolls / initial stock movements exist — safe to delete after confirm. */
  canDelete: boolean;
  summaryLines: string[];
};

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

function buildBlockedMessage(impact: Pick<ColorDeletionImpact, "summaryLines">): string {
  if (impact.summaryLines.length === 0) return INVENTORY_DELETE_BLOCKED_MESSAGE;
  return `لا يمكن حذف اللون:\n${impact.summaryLines.map((l) => `• ${l}`).join("\n")}`;
}

/**
 * Read-only: what references this color (and its rolls). Used by the UI before
 * confirm, and by delete to build a precise Arabic refusal.
 */
export async function computeColorDeletionImpact(
  tx: Tx,
  tenantId: string,
  colorId: string,
): Promise<ColorDeletionImpact> {
  const [color] = await tx
    .select({ id: colors.id, name: colors.name })
    .from(colors)
    .where(and(eq(colors.id, colorId), eq(colors.tenantId, tenantId)))
    .limit(1);
  if (!color) {
    throw Object.assign(new Error("اللون غير موجود"), { code: "COLOR_NOT_FOUND" as const });
  }

  const rollRows = await tx
    .select({ id: rolls.id, rollNo: rolls.rollNo })
    .from(rolls)
    .where(and(eq(rolls.colorId, colorId), eq(rolls.tenantId, tenantId)));
  const rollIds = rollRows.map((r) => r.id);

  const invoiceConds = [inArray(invoiceLines.colorId, [colorId])];
  if (rollIds.length) invoiceConds.push(inArray(invoiceLines.rollId, rollIds));
  const invoiceRows = await tx
    .selectDistinct({
      id: invoices.id,
      number: invoices.number,
      type: invoices.type,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.tenantId, tenantId),
        eq(invoices.status, "active"),
        or(...invoiceConds),
      ),
    )
    .orderBy(desc(invoices.number))
    .limit(50);

  const orderConds = [inArray(orderItems.colorId, [colorId])];
  if (rollIds.length) orderConds.push(inArray(orderItems.rollId, rollIds));
  const orderRows = await tx
    .selectDistinct({
      id: orders.id,
      code: orders.code,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.tenantId, tenantId), or(...orderConds)))
    .limit(50);

  const returnRows =
    rollIds.length === 0
      ? []
      : await tx
          .selectDistinct({
            id: returns.id,
            number: returns.number,
          })
          .from(returnLines)
          .innerJoin(returns, eq(returns.id, returnLines.returnId))
          .where(
            and(
              eq(returnLines.tenantId, tenantId),
              eq(returns.status, "active"),
              inArray(returnLines.rollId, rollIds),
            ),
          )
          .limit(50);

  const printRows =
    rollIds.length === 0
      ? []
      : await tx
          .select({
            id: printJobs.id,
            number: printJobs.number,
          })
          .from(printJobs)
          .where(
            and(
              eq(printJobs.tenantId, tenantId),
              or(inArray(printJobs.sourceRollId, rollIds), inArray(printJobs.resultRollId, rollIds)),
            ),
          )
          .limit(50);

  const [movCount] =
    rollIds.length === 0
      ? [{ n: 0 }]
      : await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(stockMovements)
          .where(and(eq(stockMovements.tenantId, tenantId), inArray(stockMovements.rollId, rollIds)));

  const invoiceRefs: ColorDeletionRef[] = invoiceRows.map((r) => ({
    kind: "invoice",
    id: r.id,
    label: `فاتورة ${r.type === "entry" ? "شراء" : "بيع"} رقم ${r.number}`,
  }));
  const orderRefs: ColorDeletionRef[] = orderRows.map((r) => ({
    kind: "order",
    id: r.id,
    label: `طلبية رقم ${r.code}`,
  }));
  const returnRefs: ColorDeletionRef[] = returnRows.map((r) => ({
    kind: "return",
    id: r.id,
    label: `مرتجع رقم ${r.number}`,
  }));
  const printJobRefs: ColorDeletionRef[] = printRows.map((r) => ({
    kind: "print_job",
    id: r.id,
    label: `سند طباعة رقم ${r.number}`,
  }));

  const summaryLines: string[] = [];
  if (invoiceRefs.length)
    summaryLines.push(
      `اللون مرتبط بـ ${invoiceRefs.length} فاتورة: ${invoiceRefs
        .slice(0, 5)
        .map((r) => r.label.replace(/^فاتورة (شراء|بيع) رقم /, ""))
        .join("، ")}${invoiceRefs.length > 5 ? "…" : ""}`,
    );
  if (orderRefs.length) summaryLines.push(`اللون مرتبط بـ ${orderRefs.length} طلبية`);
  if (returnRefs.length) summaryLines.push(`اللون مرتبط بـ ${returnRefs.length} مرتجع`);
  if (printJobRefs.length) summaryLines.push(`اللون مرتبط بـ ${printJobRefs.length} سند طباعة`);
  if (rollRows.length) summaryLines.push(`اللون مرتبط بـ ${rollRows.length} صبغة (لفة)`);
  if (Number(movCount?.n ?? 0) > 0)
    summaryLines.push(`اللون مرتبط بـ ${movCount?.n ?? 0} حركة مخزون`);

  const blocked =
    invoiceRefs.length > 0 ||
    orderRefs.length > 0 ||
    returnRefs.length > 0 ||
    printJobRefs.length > 0;

  return {
    colorId,
    colorName: color.name,
    rollsCount: rollRows.length,
    stockMovementsCount: Number(movCount?.n ?? 0),
    invoiceRefs,
    orderRefs,
    returnRefs,
    printJobRefs,
    canDelete: !blocked,
    summaryLines,
  };
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

  // Prefer a detailed color-scoped message when a single color is being deleted.
  if (colorIds.length === 1 && !fabricId) {
    const impact = await computeColorDeletionImpact(tx, t, colorIds[0]!);
    if (!impact.canDelete) {
      throw new Error(buildBlockedMessage(impact));
    }
  } else {
    const total =
      (await countInvoiceRefs(tx, t, rollIds, colorIds, fabricId)) +
      (await countOrderRefs(tx, t, rollIds, colorIds, fabricId)) +
      (await countReturnRefs(tx, t, rollIds)) +
      (await countPrintJobRefs(tx, t, rollIds));

    if (total > 0) {
      throw new Error(INVENTORY_DELETE_BLOCKED_MESSAGE);
    }
  }

  if (rollIds.length > 0) {
    await tx
      .delete(stockMovements)
      .where(and(inArray(stockMovements.rollId, rollIds), eq(stockMovements.tenantId, t)));
  }
}
