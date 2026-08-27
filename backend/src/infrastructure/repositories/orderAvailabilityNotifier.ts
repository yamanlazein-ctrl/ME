import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { notifications } from "../orm/schemas/notification.table.js";
import type { DB } from "../orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * BUG-07 — orders are purely INFORMATIONAL: no roll is ever locked. The
 * system's job is to surface what is available for which pending order via
 * notifications so the OWNER decides what to sell and when.
 */

/** Sum of remainingKg across in_stock rolls of one color. */
export async function colorAvailableKg(
  tx: Tx,
  ctx: TenantContext,
  colorId: string,
): Promise<number> {
  const [agg] = await tx
    .select({ total: sql<number>`COALESCE(SUM(${rolls.remainingKg}), 0)` })
    .from(rolls)
    .where(
      and(
        eq(rolls.colorId, colorId),
        eq(rolls.tenantId, ctx.tenantId),
        eq(rolls.status, "in_stock"),
      ),
    );
  return Number(agg?.total ?? 0);
}

type ItemAvailability = {
  fabricName: string;
  colorName: string;
  requestedKg: number;
  availableKg: number;
};

const fmtKg = (n: number) => String(Math.round(n * 100) / 100);

function coverageLines(avails: ItemAvailability[]): string[] {
  return avails
    .filter((a) => a.availableKg > 0)
    .map(
      (a) =>
        `${a.fabricName}/${a.colorName}: يتوفر ${fmtKg(a.availableKg)} كغ من أصل ${fmtKg(a.requestedKg)} كغ مطلوبة`,
    );
}

/**
 * BUG-07 spec §1 — called inside the SAME transaction that creates an order:
 * computes initial availability, promotes the order's status accordingly and,
 * when any quantity is available NOW, notifies the owner (sell now or wait).
 * Name-only items (no colorId) can never be matched → order stays "open".
 */
export async function applyOrderAvailabilityAtCreation(
  tx: Tx,
  ctx: TenantContext,
  orderId: string,
): Promise<void> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))
    .limit(1);
  if (!order) return;
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  if (!items.length || items.some((it) => !it.colorId)) return;

  const avails: ItemAvailability[] = [];
  let anyPositive = false;
  let allFull = true;
  for (const it of items) {
    const availableKg = await colorAvailableKg(tx, ctx, it.colorId!);
    avails.push({
      fabricName: it.fabricName,
      colorName: it.colorName,
      requestedKg: Number(it.requestedKg),
      availableKg,
    });
    if (availableKg > 0) anyPositive = true;
    if (availableKg < Number(it.requestedKg)) allFull = false;
  }

  const newStatus = !anyPositive ? "open" : allFull ? "available" : "partially_available";
  if (newStatus !== "open") {
    await tx
      .update(orders)
      .set({ status: newStatus, updatedAt: new Date(), version: sql`${orders.version} + 1` })
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)));
  }

  const who = order.customerNameSnapshot ? ` للعميل ${order.customerNameSnapshot}` : "";
  await tx.insert(notifications).values({
    tenantId: ctx.tenantId,
    userId: null,
    title: `الطلبية ${order.code} — يوجد مخزون متطابق`,
    detail:
      `الطلبية ${order.code}${who}: ` +
      `${coverageLines(avails).join(" • ")}. ` +
      `يمكنك بيع الكمية المتوفرة الآن بفاتورة بيع عادية، أو الانتظار حتى تكتمل الكمية.`,
    kind: "info",
    severity: "success",
    targetPath: "/orders",
  });
}

/**
 * C2 — auto-link open customer orders to newly arrived stock (BUG-07 spec §3).
 *
 * Called inside the SAME transaction that adds stock (entry invoice, roll
 * creation, print receive). Notifies on every stock arrival that IMPROVES the
 * order's coverage: any status transition, or a partial order that stays
 * partial while matching stock just arrived. The message includes concrete
 * contents (fabric/color, available vs requested kg).
 */
/**
 * OI-6 — heals order lines recorded for a colour that did not exist yet.
 *
 * Such lines are stored with `colorId = NULL` (name only). When that colour
 * finally becomes a real row (entry invoice / roll arrival), link every
 * still-pending order line to it by name + fabric and backfill `colorId`, so
 * that every colour-keyed path sees the line again:
 *   • notifyOrderAvailability (stock-arrival notification, C2)
 *   • colorAvailableKg aggregation
 *   • findPendingConflicts (BUG-07 sale warning)
 */
async function backfillNameOnlyOrderItems(
  tx: Tx,
  ctx: TenantContext,
  colorIds: string[],
): Promise<void> {
  if (!colorIds.length) return;
  const arriving = await tx
    .select({ id: colors.id, name: colors.name, fabricId: colors.fabricId })
    .from(colors)
    .where(and(eq(colors.tenantId, ctx.tenantId), inArray(colors.id, colorIds)));
  if (!arriving.length) return;

  for (const c of arriving) {
    const colorName = c.name.trim().toLowerCase();
    if (!colorName) continue;
    const orphans = await tx
      .select({ item: orderItems })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenantId),
          inArray(orders.status, ["open", "partially_available"]),
          isNull(orderItems.colorId),
          eq(sql`lower(trim(${orderItems.colorName}))`, colorName),
        ),
      );
    for (const { item } of orphans) {
      // Fabric guard: never link across fabrics. When the line itself has no
      // fabricId (fabric was also name-only), colour name is the only signal.
      if (item.fabricId && item.fabricId !== c.fabricId) continue;
      await tx
        .update(orderItems)
        .set({ colorId: c.id })
        .where(and(eq(orderItems.id, item.id), eq(orderItems.tenantId, ctx.tenantId)));
    }
  }
}

export async function notifyOrderAvailability(
  tx: Tx,
  ctx: TenantContext,
  colorIds: string[],
): Promise<void> {
  if (!colorIds.length) return;

  // OI-6 — first link name-only order lines to the colours that just arrived.
  await backfillNameOnlyOrderItems(tx, ctx, colorIds);

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
    const first = rows.find((r) => r.order.id === orderId)!;
    const items = rows.filter((r) => r.order.id === orderId).map((r) => r.item);
    if (items.some((it) => !it.colorId)) continue;

    const avails: ItemAvailability[] = [];
    let anyPositive = false;
    let allFull = true;
    for (const it of items) {
      const availableKg = await colorAvailableKg(tx, ctx, it.colorId!);
      avails.push({
        fabricName: it.fabricName,
        colorName: it.colorName,
        requestedKg: Number(it.requestedKg),
        availableKg,
      });
      if (availableKg > 0) anyPositive = true;
      if (availableKg < Number(it.requestedKg)) allFull = false;
    }

    const newStatus = !anyPositive ? "open" : allFull ? "available" : "partially_available";
    const oldStatus = first.order.status;
    // Improvement gate: any status transition, OR a still-partial order whose
    // matching stock just grew. No change in material coverage → no notify.
    const improved =
      newStatus !== oldStatus ||
      (newStatus === "partially_available" && oldStatus === "partially_available");
    if (!improved) continue;

    if (newStatus !== oldStatus) {
      await tx
        .update(orders)
        .set({ status: newStatus, updatedAt: new Date(), version: sql`${orders.version} + 1` })
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)));
    }

    const customer = first.order.customerNameSnapshot
      ? ` للعميل ${first.order.customerNameSnapshot}`
      : "";
    await tx.insert(notifications).values({
      tenantId: ctx.tenantId,
      userId: null,
      title: `تحسّن توفّر الطلبية ${first.order.code}`,
      detail:
        `تم تحقيق الطلبية ${first.order.code}${customer} ` +
        `${allFull ? "كاملاً" : "جزئياً"} بعد دخول مخزون جديد. المحتوى: ` +
        `${coverageLines(avails).join(" • ")}.`,
      kind: "info",
      severity: "success",
      targetPath: "/orders",
    });
  }
}
