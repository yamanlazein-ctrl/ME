import { and, eq, inArray, sql } from "drizzle-orm";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { notifications } from "../orm/schemas/notification.table.js";
import type { DB } from "../orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * C2 — auto-link open customer orders to newly arrived stock.
 *
 * Called inside the SAME transaction that adds stock (entry invoice, roll
 * creation). For every open / partially_available order whose items reference
 * one of `colorIds`:
 *   - recompute availability from current in_stock rolls of that color,
 *   - promote the order to `available` / `partially_available`,
 *   - create ONE notification (targetPath=/orders) — only on a status
 *     transition, so repeated stock arrivals never re-notify.
 *
 * Orders whose items carry no colorId (name-only) are skipped: they can never
 * be matched to stock.
 */
export async function notifyOrderAvailability(
  tx: Tx,
  ctx: TenantContext,
  colorIds: string[],
): Promise<void> {
  if (!colorIds.length) return;

  const rows = await tx
    .select({ order: orders, item: orderItems })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.tenantId, ctx.tenantId),
        inArray(orders.status, ["open", "partially_available"]),
        inArray(orderItems.colorId, colorIds),
      ),
    );
  if (!rows.length) return;

  const orderIds = [...new Set(rows.map((r) => r.order.id))];
  for (const orderId of orderIds) {
    const items = rows.filter((r) => r.order.id === orderId).map((r) => r.item);
    if (items.some((it) => !it.colorId)) continue;

    let anyPositive = false;
    let allFulfillable = true;
    for (const it of items) {
      const [agg] = await tx
        .select({ total: sql<number>`COALESCE(SUM(${rolls.remainingKg}), 0)` })
        .from(rolls)
        .where(
          and(
            eq(rolls.colorId, it.colorId!),
            eq(rolls.tenantId, ctx.tenantId),
            eq(rolls.status, "in_stock"),
          ),
        );
      const available = Number(agg?.total ?? 0);
      if (available >= Number(it.requestedKg)) {
        anyPositive = true;
      } else if (available > 0) {
        anyPositive = true;
        allFulfillable = false;
      } else {
        allFulfillable = false;
      }
    }

    const newStatus = !anyPositive
      ? "open"
      : allFulfillable
        ? "available"
        : "partially_available";
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))
      .limit(1);
    if (!order || order.status === newStatus) continue;

    await tx
      .update(orders)
      .set({
        status: newStatus,
        updatedAt: new Date(),
        version: sql`${orders.version} + 1`,
      })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)));

    if (newStatus !== "open") {
      const customer = order.customerNameSnapshot
        ? ` للعميل ${order.customerNameSnapshot}`
        : "";
      await tx.insert(notifications).values({
        tenantId: ctx.tenantId,
        userId: null,
        title: `الطلبية ${order.code} أصبحت ${newStatus === "available" ? "متوفرة" : "متوفرة جزئياً"}`,
        detail: `أصبحت الطلبية ${order.code}${customer} متاحة بعد دخول المخزون المطابق.`,
        kind: "info",
        severity: "success",
        targetPath: "/orders",
      });
    }
  }
}
