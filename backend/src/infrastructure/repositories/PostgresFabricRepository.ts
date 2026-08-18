import { eq, and, desc, ilike, or, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IFabricRepository,
  FabricFilter,
  CreateFabricData,
} from "../../application/ports/IFabricRepository.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { cleanupRollsForDeletion } from "./rollDeletionHelper.js";
import { Fabric, type FabricData } from "../../domain/entities/Fabric.js";
import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export class PostgresFabricRepository implements IFabricRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<FabricData | null> {
    const rows = await this.db
      .select()
      .from(fabrics)
      .where(and(eq(fabrics.id, id), eq(fabrics.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: FabricFilter, ctx: TenantContext): Promise<PaginatedResult<FabricData>> {
    const conditions = [eq(fabrics.tenantId, ctx.tenantId)];
    if (filter.search) {
      conditions.push(ilike(fabrics.name, `%${filter.search}%`));
    }
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(fabrics)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(fabrics.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(fabrics)
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

  async create(data: CreateFabricData, ctx: TenantContext): Promise<FabricData> {
    const [row] = await this.db
      .insert(fabrics)
      .values({
        tenantId: ctx.tenantId,
        name: data.name,
        category: data.category,
        minStockKg: String(data.minStockKg ?? 0),
        unit: data.unit,
        notes: data.notes,
        imageUrl: data.imageUrl,
        createdBy: ctx.userId,
      })
      .returning();
    return this.toDomain(row);
  }

  async update(
    id: string,
    data: Partial<CreateFabricData>,
    ctx: TenantContext,
  ): Promise<FabricData> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) values.name = data.name;
    if (data.category !== undefined) values.category = data.category ?? null;
    if (data.minStockKg !== undefined) values.minStockKg = String(data.minStockKg);
    if (data.unit !== undefined) values.unit = data.unit ?? null;
    if (data.notes !== undefined) values.notes = data.notes ?? null;
    if (data.imageUrl !== undefined) values.imageUrl = data.imageUrl ?? null;
    const [row] = await this.db
      .update(fabrics)
      .set(values)
      .where(and(eq(fabrics.id, id), eq(fabrics.tenantId, ctx.tenantId)))
      .returning();
    if (!row) throw new Error("Fabric not found");
    return this.toDomain(row);
  }

  async delete(id: string, ctx: TenantContext): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const colorRows = await tx
        .select({ id: colors.id })
        .from(colors)
        .where(and(eq(colors.fabricId, id), eq(colors.tenantId, ctx.tenantId)));
      const colorIds = colorRows.map((c) => c.id);

      const rollRows = colorIds.length
        ? await tx
            .select({ id: rolls.id })
            .from(rolls)
            .where(and(inArray(rolls.colorId, colorIds), eq(rolls.tenantId, ctx.tenantId)))
        : [];
      const rollIds = rollRows.map((r) => r.id);

      // Guard against business references and clean the rolls' stock movements so
      // the DELETE below doesn't fail on the stock_movements.roll_id FK.
      await cleanupRollsForDeletion({ tx, ctx, rollIds, colorIds, fabricId: id });

      if (rollIds.length > 0) {
        await tx
          .delete(rolls)
          .where(and(inArray(rolls.id, rollIds), eq(rolls.tenantId, ctx.tenantId)));
      }
      if (colorIds.length > 0) {
        await tx
          .delete(colors)
          .where(and(eq(colors.fabricId, id), eq(colors.tenantId, ctx.tenantId)));
      }
      const deleted = await tx
        .delete(fabrics)
        .where(and(eq(fabrics.id, id), eq(fabrics.tenantId, ctx.tenantId)))
        .returning({ id: fabrics.id });
      return deleted.length > 0;
    });
  }

  private toDomain(row: typeof fabrics.$inferSelect): FabricData {
    return Fabric.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof fabrics.$inferSelect): FabricData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      category: n(row.category),
      minStockKg: Number(row.minStockKg ?? 0),
      unit: n(row.unit),
      notes: n(row.notes),
      imageUrl: n(row.imageUrl),
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
