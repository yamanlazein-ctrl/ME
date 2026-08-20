import { eq, and, desc, ilike, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IOrderRepository, OrderFilter } from "../../application/ports/IOrderRepository.js";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { Order, type OrderData, type CreateOrderInput } from "../../domain/entities/Order.js";
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
        // Phase 3.1/3.2 — reservation:
        //  - items carrying rollId pin a specific roll: the roll must exist,
        //    be in_stock, belong to the item's color, and have enough kg.
        //    We mark it `reserved` so it can't be double-sold while the order
        //    is open.
        //  - items without rollId fall back to the aggregate color availability
        //    check (sum of remainingKg across rolls of that color).
        for (const it of input.items) {
          if (it.rollId) {
            const [rollRow] = await tx
              .select()
              .from(rolls)
              .where(and(eq(rolls.id, it.rollId), eq(rolls.tenantId, ctx.tenantId)))
              .for("update") // Fix H-4: lock the row so a concurrent order creation
              // cannot read the same "in_stock" snapshot before this transaction commits.
              .limit(1);
            if (!rollRow) {
              throw new Error("اللفافة المحددة غير موجودة");
            }
            if (it.colorId && rollRow.colorId !== it.colorId) {
              throw new Error("اللفافة المحددة لا تنتمي إلى اللون المطلوب");
            }
            if (rollRow.status !== "in_stock") {
              throw new Error("اللفافة المحددة محجوزة أو مستهلكة");
            }
            if (Number(rollRow.remainingKg) < it.requestedKg) {
              throw new Error(
                `الكمية المطلوبة (${it.requestedKg} كغ) لللفافة ${rollRow.rollNo} تتجاوز الرصيد المتاح (${Number(rollRow.remainingKg)} كغ)`,
              );
            }
            const reservedRows = await tx
              .update(rolls)
              .set({ status: "reserved", updatedAt: new Date() })
              // Fix H-4: re-assert status in the WHERE clause as a belt-and-braces
              // guard even though the row lock above already serializes this path.
              .where(
                and(
                  eq(rolls.id, rollRow.id),
                  eq(rolls.tenantId, ctx.tenantId),
                  eq(rolls.status, "in_stock"),
                ),
              )
              .returning({ id: rolls.id });
            if (reservedRows.length === 0) {
              throw new Error("اللفافة المحددة محجوزة أو مستهلكة");
            }
          } else if (it.colorId) {
            // Future-order support: items pinned to a color do NOT require the
            // stock to exist yet. When stock is insufficient the order stays
            // "open" (no reservation) and the availability notifier promotes it
            // automatically once matching stock arrives (entry invoice / roll).
            // Orders whose stock IS sufficient keep the previous behavior.
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

      // Release reservations: the rolls pinned to this order were consumed by the
      // fulfillment invoice, so drop them back to their natural status
      // (in_stock if any kg remain, exhausted otherwise).
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      const rollIds = items.map((it) => it.rollId).filter((r): r is string => Boolean(r));
      if (rollIds.length > 0) {
        const reserved = await tx
          .select({ id: rolls.id, remainingKg: rolls.remainingKg })
          .from(rolls)
          .where(
            and(
              eq(rolls.tenantId, ctx.tenantId),
              inArray(rolls.id, rollIds),
              eq(rolls.status, "reserved"),
            ),
          );
        for (const r of reserved) {
          const newKg = Number(r.remainingKg);
          await tx
            .update(rolls)
            .set({
              status: newKg <= 0 ? "exhausted" : "in_stock",
              updatedAt: new Date(),
              version: sql`${rolls.version} + 1`,
            })
            .where(eq(rolls.id, r.id));
        }
      }
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

      // Release reservations: any roll pinned to this order's items and still
      // marked `reserved` goes back to `in_stock`.
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, id));
      const rollIds = items.map((it) => it.rollId).filter((r): r is string => Boolean(r));
      if (rollIds.length > 0) {
        await tx
          .update(rolls)
          .set({ status: "in_stock", updatedAt: new Date() })
          .where(
            and(
              eq(rolls.tenantId, ctx.tenantId),
              inArray(rolls.id, rollIds),
              eq(rolls.status, "reserved"),
            ),
          );
      }
      return this.toDomain(row, items);
    });
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
