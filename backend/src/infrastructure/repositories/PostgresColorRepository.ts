import { eq, and, desc, ilike, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IColorRepository,
  ColorFilter,
  CreateColorData,
} from "../../application/ports/IColorRepository.js";
import { colors } from "../orm/schemas/color.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { cleanupRollsForDeletion } from "./rollDeletionHelper.js";
import { Color, type ColorData } from "../../domain/entities/Color.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresColorRepository implements IColorRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<ColorData | null> {
    const rows = await this.db
      .select()
      .from(colors)
      .where(and(eq(colors.id, id), eq(colors.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: ColorFilter, ctx: TenantContext): Promise<PaginatedResult<ColorData>> {
    const conditions = [eq(colors.tenantId, ctx.tenantId)];
    if (filter.fabricId) conditions.push(eq(colors.fabricId, filter.fabricId));
    if (filter.search) conditions.push(ilike(colors.name!, `%${filter.search}%`)!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(colors)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(colors.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(colors)
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

  async create(data: CreateColorData, ctx: TenantContext): Promise<ColorData> {
    const [row] = await this.db
      .insert(colors)
      .values({
        tenantId: ctx.tenantId,
        fabricId: data.fabricId,
        name: data.name,
        code: data.code,
        hex: data.hex,
        imageUrl: data.imageUrl,
      })
      .returning();
    return this.toDomain(row);
  }

  async update(id: string, data: Partial<CreateColorData>, ctx: TenantContext): Promise<ColorData> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) values.name = data.name;
    if (data.code !== undefined) values.code = data.code ?? null;
    if (data.hex !== undefined) values.hex = data.hex ?? null;
    if (data.imageUrl !== undefined) values.imageUrl = data.imageUrl ?? null;
    const [row] = await this.db
      .update(colors)
      .set(values)
      .where(and(eq(colors.id, id), eq(colors.tenantId, ctx.tenantId)))
      .returning();
    if (!row) throw new Error("Color not found");
    return this.toDomain(row);
  }

  async delete(id: string, ctx: TenantContext): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rollRows = await tx
        .select({ id: rolls.id })
        .from(rolls)
        .where(and(eq(rolls.colorId, id), eq(rolls.tenantId, ctx.tenantId)));
      const rollIds = rollRows.map((r) => r.id);

      await cleanupRollsForDeletion({ tx, ctx, rollIds, colorIds: [id] });

      if (rollIds.length > 0) {
        await tx
          .delete(rolls)
          .where(and(inArray(rolls.id, rollIds), eq(rolls.tenantId, ctx.tenantId)));
      }
      const deleted = await tx
        .delete(colors)
        .where(and(eq(colors.id, id), eq(colors.tenantId, ctx.tenantId)))
        .returning({ id: colors.id });
      return deleted.length > 0;
    });
  }

  private toDomain(row: typeof colors.$inferSelect): ColorData {
    return Color.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof colors.$inferSelect): ColorData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      fabricId: row.fabricId,
      name: row.name,
      code: n(row.code),
      hex: n(row.hex),
      imageUrl: n(row.imageUrl),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
