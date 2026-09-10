import { eq, and, desc, ilike, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IOrderRepository,
  OrderFilter,
  PendingConflict,
  PendingConflictLine,
} from "../../application/ports/IOrderRepository.js";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { Order, type OrderData, type CreateOrderInput } from "../../domain/entities/Order.js";
import { applyOrderAvailabilityAtCreation } from "./orderAvailabilityNotifier.js";
import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export class PostgresOrderRepository implements IOrderRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<OrderData | null> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, id));
    return this.toDomain(rows[0], items);
  }

  async findByCode(code: string, ctx: TenantContext): Promise<OrderData | null> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.code, code), eq(orders.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, rows[0].id));
    return this.toDomain(rows[0], items);
  }

  async list(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<OrderData>> {
    const conditions = [eq(orders.tenantId, ctx.tenantId)];
    if (filter.customerId) conditions.push(eq(orders.customerId, filter.customerId));
    if (filter.status) conditions.push(eq(orders.status, filter.status));
    if (filter.search) conditions.push(ilike(orders.code, `%${filter.search}%`));
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(orders)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(orders.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(where),
    ]);

    const orderIds = dataRows.map((r) => r.id);
    const items =
      orderIds.length > 0
        ? await this.db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds))
        : [];
    const itemsByOrder = new Map<string, typeof items>();
    for (const it of items) {
      const list = itemsByOrder.get(it.orderId) ?? [];
      list.push(it);
      itemsByOrder.set(it.orderId, list);
    }

    return {
      data: dataRows.map((r) => this.toDomain(r, itemsByOrder.get(r.id) ?? [])),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(input: CreateOrderInput, autoCode: string, ctx: TenantContext): Promise<OrderData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(orders)
        .values({
          ...(input.preAllocatedId ? { id: input.preAllocatedId } : {}),
          tenantId: ctx.tenantId,
          code: autoCode,
          customerId: input.customerId ?? null,
          customerNameSnapshot: input.customerNameSnapshot,
          customerPhoneSnapshot: input.customerPhoneSnapshot,
          date: input.date,
          currency: input.currency ?? "SYP",
          notes: input.notes,
        })
        .returning();

      if (input.items.length > 0) {
        // BUG-07 — orders are informational: rollId is stored as a reference
        // ONLY. No roll is ever marked `reserved`, and no stock requirement is
        // enforced at order time — the owner decides what to sell and when.
        // We still validate the reference itself (exists + belongs to the
        // item's color) so stale/wrong pins fail fast instead of misleading.
        for (const it of input.items) {
          if (it.rollId) {
            const [rollRow] = await tx
              .select({ id: rolls.id, colorId: rolls.colorId })
              .from(rolls)
              .where(and(eq(rolls.id, it.rollId), eq(rolls.tenantId, ctx.tenantId)))
              .limit(1);
            if (!rollRow) {
              throw new Error("اللفافة المحددة غير موجودة");
            }
            if (it.colorId && rollRow.colorId !== it.colorId) {
              throw new Error("اللفافة المحددة لا تنتمي إلى اللون المطلوب");
            }
          }
        }
        await tx.insert(orderItems).values(
          input.items.map((it) => ({
            tenantId: ctx.tenantId,
            orderId: row.id,
            fabricId: it.fabricId ?? null,
            fabricName: it.fabricName,
            colorId: it.colorId ?? null,
            colorName: it.colorName,
            colorCode: it.colorCode,
            requestedKg: String(it.requestedKg),
            pieces: it.pieces ?? 1,
            rollId: it.rollId ?? null,
            widthCm: it.widthCm ? String(it.widthCm) : null,
            weightGsm: it.weightGsm ? String(it.weightGsm) : null,
            notes: it.notes,
          })),
        );
      }

      // BUG-07 §1 — compute initial availability and notify the owner
      // (informational only: sell now or wait is their decision).
      await applyOrderAvailabilityAtCreation(tx, ctx, row.id);

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, row.id));
      return this.toDomain(row, items);
    });
  }

  async update(
    id: string,
    data: Partial<CreateOrderInput>,
    ctx: TenantContext,
  ): Promise<OrderData> {
    const values: Record<string, unknown> = {
      updatedAt: new Date(),
      version: sql`${orders.version} + 1`,
    };
    if (data.notes !== undefined) values.notes = data.notes ?? null;
    if (data.customerNameSnapshot !== undefined)
      values.customerNameSnapshot = data.customerNameSnapshot;
    if (data.customerPhoneSnapshot !== undefined)
      values.customerPhoneSnapshot = data.customerPhoneSnapshot ?? null;
    if (data.date !== undefined) values.date = data.date;
    const [row] = await this.db
      .update(orders)
      .set(values)
      .where(and(eq(orders.id, id), eq(orders.tenantId, ctx.tenantId)))
      .returning();
    if (!row) throw new Error("Order not found");
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, id));
    return this.toDomain(row, items);
  }

  async fulfill(id: string, invoiceId: UUID, ctx: TenantContext): Promise<OrderData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(orders)
        .set({
          status: "fulfilled",
          fulfilledInvoiceId: invoiceId,
          updatedAt: new Date(),
          version: sql`${orders.version} + 1`,
        })
        .where(
          and(
            eq(orders.id, id),
            eq(orders.tenantId, ctx.tenantId),
            inArray(orders.status, ["open", "available", "partially_available"]),
          ),
        )
        .returning();
      if (!row) throw new Error("Order not found or not in an open/available status");

      // BUG-07 — no reservation release needed: rolls are never locked by orders.
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      return this.toDomain(row, items);
    });
  }

  async cancel(id: string, ctx: TenantContext): Promise<OrderData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(orders)
        .set({
          status: "cancelled",
          updatedAt: new Date(),
          version: sql`${orders.version} + 1`,
        })
        .where(
          and(
            eq(orders.id, id),
            eq(orders.tenantId, ctx.tenantId),
            inArray(orders.status, ["open", "available", "partially_available"]),
          ),
        )
        .returning();
      if (!row) throw new Error("Order not found or already processed");

      // BUG-07 — no reservation release needed: rolls are never locked by orders.
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      return this.toDomain(row, items);
    });
  }

  /**
   * BUG-07 soft warning — find open/pending orders whose items match any of
   * the given sale lines (by colorId, or by fabricId when the line carries no
   * color). Purely informational; callers must not block sales on this.
   */
  async findPendingConflicts(
    lines: PendingConflictLine[],
    ctx: TenantContext,
  ): Promise<PendingConflict[]> {
    const rows = await this.db
      .select({ order: orders, item: orderItems })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.tenantId, ctx.tenantId),
          inArray(orders.status, ["open", "partially_available", "available"]),
        ),
      );

    const matchesLine = (
      it: typeof orderItems.$inferSelect,
      ln: PendingConflictLine,
    ): boolean => {
      if (ln.colorId) return it.colorId === ln.colorId;
      if (ln.fabricId) return it.fabricId === ln.fabricId;
      return false;
    };

    const byOrder = new Map<string, PendingConflict>();
    for (const { order, item } of rows) {
      const matched = lines.filter((ln) => matchesLine(item, ln));
      if (matched.length === 0) continue;
      let entry = byOrder.get(order.id);
      if (!entry) {
        entry = {
          orderId: order.id,
          code: order.code,
          customerNameSnapshot: order.customerNameSnapshot,
          items: [],
        };
        byOrder.set(order.id, entry);
      }
      entry.items.push({
        fabricName: item.fabricName,
        colorName: item.colorName,
        requestedKg: Number(item.requestedKg),
      });
    }
    return [...byOrder.values()];
  }

  private toDomain(
    row: typeof orders.$inferSelect,
    itemsRows: (typeof orderItems.$inferSelect)[],
  ): OrderData {
    return Order.reconstitute(this.mapRow(row, itemsRows)).toData();
  }

  private mapRow(
    row: typeof orders.$inferSelect,
    itemsRows: (typeof orderItems.$inferSelect)[],
  ): OrderData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      code: row.code,
      customerId: n(row.customerId),
      customerNameSnapshot: row.customerNameSnapshot,
      customerPhoneSnapshot: n(row.customerPhoneSnapshot),
      date: row.date,
      status: row.status as OrderData["status"],
      currency: row.currency,
      notes: n(row.notes),
      fulfilledInvoiceId: n(row.fulfilledInvoiceId),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      items: itemsRows.map((it) => ({
        id: it.id,
        fabricId: n(it.fabricId),
        fabricName: it.fabricName,
        colorId: n(it.colorId),
        colorName: it.colorName,
        colorCode: n(it.colorCode),
        requestedKg: Number(it.requestedKg),
        rollId: n(it.rollId),
        widthCm: it.widthCm ? Number(it.widthCm) : undefined,
        weightGsm: it.weightGsm ? Number(it.weightGsm) : undefined,
        notes: n(it.notes),
      })),
    };
  }
}
