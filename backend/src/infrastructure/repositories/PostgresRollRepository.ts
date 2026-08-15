import { eq, and, desc, ilike, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IRollRepository,
  RollFilter,
  CreateRollData,
} from "../../application/ports/IRollRepository.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { notifyOrderAvailability } from "./orderAvailabilityNotifier.js";
import { Roll, type RollData } from "../../domain/entities/Roll.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresRollRepository implements IRollRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<RollData | null> {
    const rows = await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async findByRollNo(rollNo: string, ctx: TenantContext): Promise<RollData | null> {
    const rows = await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.rollNo, rollNo), eq(rolls.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: RollFilter, ctx: TenantContext): Promise<PaginatedResult<RollData>> {
    const conditions = [eq(rolls.tenantId, ctx.tenantId)];
    if (filter.colorId) conditions.push(eq(rolls.colorId, filter.colorId));
    if (filter.status) conditions.push(eq(rolls.status, filter.status));
    if (filter.search) conditions.push(ilike(rolls.rollNo!, `%${filter.search}%`)!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(rolls)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(rolls.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(rolls)
        .where(where),
    ]);

    return {
      data: dataRows.map((r) => this.toDomain(r)),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(data: CreateRollData, ctx: TenantContext): Promise<RollData> {
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(rolls)
        .values({
          tenantId: ctx.tenantId,
          colorId: data.colorId,
          rollNo: data.rollNo,
          dyeBatch: data.dyeBatch,
          initialKg: String(data.initialKg),
          remainingKg: String(data.remainingKg ?? data.initialKg),
          pricePerKg: String(data.pricePerKg),
          salePricePerKg: data.salePricePerKg ? String(data.salePricePerKg) : null,
          currency: data.currency ?? "SYP",
          supplierId: data.supplierId ?? null,
          entryDate: data.entryDate,
          widthCm: data.widthCm ? String(data.widthCm) : null,
          weightGsm: data.weightGsm ? String(data.weightGsm) : null,
        })
        .returning();
      await recordStockMovement(
        tx,
        {
          rollId: r.id,
          direction: "in",
          movementType: "initial",
          quantityKg: data.remainingKg ?? data.initialKg,
          balanceAfterKg: data.remainingKg ?? data.initialKg,
          movementDate: data.entryDate,
          description: `Roll created ${data.rollNo}`,
        },
        ctx,
      );
      // C2 — auto-link: promote matching open customer orders and notify.
      await notifyOrderAvailability(tx, ctx, [data.colorId]);
      return r;
    });
    return this.toDomain(row);
  }

  async update(id: string, data: Partial<CreateRollData>, ctx: TenantContext): Promise<RollData> {
    const values: Record<string, unknown> = {
      updatedAt: new Date(),
      version: sql`${rolls.version} + 1`,
    };
    if (data.rollNo !== undefined) values.rollNo = data.rollNo;
    if (data.dyeBatch !== undefined) values.dyeBatch = data.dyeBatch ?? null;
    if (data.initialKg !== undefined) values.initialKg = String(data.initialKg);
    if (data.remainingKg !== undefined) values.remainingKg = String(data.remainingKg);
    if (data.pricePerKg !== undefined) values.pricePerKg = String(data.pricePerKg);
    if (data.salePricePerKg !== undefined)
      values.salePricePerKg = data.salePricePerKg ? String(data.salePricePerKg) : null;
    if (data.currency !== undefined) values.currency = data.currency;
    if (data.supplierId !== undefined) values.supplierId = data.supplierId ?? null;
    if (data.entryDate !== undefined) values.entryDate = data.entryDate;
    if (data.widthCm !== undefined) values.widthCm = data.widthCm ? String(data.widthCm) : null;
    if (data.weightGsm !== undefined)
      values.weightGsm = data.weightGsm ? String(data.weightGsm) : null;

    // Fix BUG-05 (forensic audit 2026-08-15, live-reproduced): PUT
    // /api/inventory/rolls/:id let remainingKg be overwritten directly with
    // no stock_movements row at all — every other write path to
    // remainingKg (invoice sale/entry, returns, print send/receive) records
    // one via recordStockMovement(); this path silently skipped it, so a
    // manual roll edit that changes stock leaves zero trace in the
    // "append-only audit trail of every stock change" the stock_movements
    // table's own schema comment promises. When remainingKg is not part of
    // this update, behavior is unchanged (a single non-transactional
    // UPDATE, as before). When it is, the update now runs inside a
    // transaction that locks the row, reads the true prior balance, and
    // writes a matching "adjustment" movement so the change is traceable
    // and reconcilable against remainingKg like every other mutation.
    if (data.remainingKg === undefined) {
      const [row] = await this.db
        .update(rolls)
        .set(values)
        .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
        .returning();
      if (!row) throw new Error("Roll not found");
      return this.toDomain(row);
    }

    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ remainingKg: rolls.remainingKg })
        .from(rolls)
        .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (!before) throw new Error("Roll not found");

      const [row] = await tx
        .update(rolls)
        .set(values)
        .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
        .returning();
      if (!row) throw new Error("Roll not found");

      const oldKg = Number(before.remainingKg);
      const newKg = Number(data.remainingKg);
      const delta = Math.round((newKg - oldKg) * 100) / 100;
      if (delta !== 0) {
        await recordStockMovement(
          tx,
          {
            rollId: id,
            direction: delta > 0 ? "in" : "out",
            movementType: "adjustment",
            quantityKg: Math.abs(delta),
            balanceAfterKg: newKg,
            movementDate: new Date().toISOString().slice(0, 10),
            description: `تعديل يدوي على اللفافة عبر شاشة المخزون (${oldKg} → ${newKg} كغ)`,
          },
          ctx,
        );
      }
      return this.toDomain(row);
    });
  }

  async decrement(
    id: string,
    kg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<RollData> {
    await this.getAndLock(id, ctx);
    const r = await this.findById(id, ctx);
    if (!r) throw new Error("Roll not found");
    Roll.reconstitute(r).decrement(kg);
    const [row] = await this.db
      .update(rolls)
      .set({
        remainingKg: String(r.remainingKg - kg),
        version: sql`${rolls.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId), eq(rolls.version, expectedVersion)),
      )
      .returning();
    if (!row) throw new Error("Concurrent modification on roll");
    return this.toDomain(row);
  }

  async increment(
    id: string,
    kg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<RollData> {
    await this.getAndLock(id, ctx);
    const r = await this.findById(id, ctx);
    if (!r) throw new Error("Roll not found");
    Roll.reconstitute(r).increment(kg);
    const [row] = await this.db
      .update(rolls)
      .set({
        remainingKg: String(r.remainingKg + kg),
        version: sql`${rolls.version} + 1`,
        status: "in_stock",
        updatedAt: new Date(),
      })
      .where(
        and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId), eq(rolls.version, expectedVersion)),
      )
      .returning();
    if (!row) throw new Error("Concurrent modification on roll");
    return this.toDomain(row);
  }

  async delete(id: string, ctx: TenantContext): Promise<boolean> {
    const deleted = await this.db
      .delete(rolls)
      .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
      .returning({ id: rolls.id });
    return deleted.length > 0;
  }

  private async getAndLock(id: string, ctx: TenantContext): Promise<void> {
    await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
      .for("update")
      .limit(1);
  }

  private toDomain(row: typeof rolls.$inferSelect): RollData {
    return Roll.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof rolls.$inferSelect): RollData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      colorId: row.colorId,
      rollNo: row.rollNo,
      dyeBatch: n(row.dyeBatch),
      initialKg: Number(row.initialKg),
      remainingKg: Number(row.remainingKg),
      pricePerKg: Number(row.pricePerKg),
      salePricePerKg: row.salePricePerKg ? Number(row.salePricePerKg) : undefined,
      currency: row.currency,
      supplierId: n(row.supplierId),
      entryDate: row.entryDate,
      widthCm: row.widthCm ? Number(row.widthCm) : undefined,
      weightGsm: row.weightGsm ? Number(row.weightGsm) : undefined,
      status: row.status as RollData["status"],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
