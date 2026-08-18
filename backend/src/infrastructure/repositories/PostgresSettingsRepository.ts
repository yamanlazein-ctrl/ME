import { eq } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import { settings } from "../orm/schemas/setting.table.js";
import { Settings, type SettingsData } from "../../domain/entities/Settings.js";
import type { TenantContext } from "../../domain/types/index.js";

const ALLOWED_SECTIONS = [
  "company",
  "currencies",
  "paymentMethods",
  "taxes",
  "units",
  "warehouses",
  "printing",
] as const;

export class PostgresSettingsRepository implements ISettingsRepository {
  constructor(private readonly db: DB) {}

  async getSettings(ctx: TenantContext): Promise<SettingsData | null> {
    const [row] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.tenantId, ctx.tenantId))
      .limit(1);
    if (!row) return null;
    return this.toDomain(row);
  }

  async upsertSection(section: string, value: unknown, ctx: TenantContext): Promise<SettingsData> {
    const [existing] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.tenantId, ctx.tenantId))
      .limit(1);

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    setValues[section] = value;

    if (existing) {
      const [row] = await this.db
        .update(settings)
        .set(setValues as Partial<typeof settings.$inferInsert>)
        .where(eq(settings.id, existing.id))
        .returning();
      return this.toDomain(row);
    }

    const insertValues: Record<string, unknown> = { tenantId: ctx.tenantId };
    insertValues[section] = value;
    const [row] = await this.db
      .insert(settings)
      .values(insertValues as unknown as typeof settings.$inferInsert)
      .returning();
    return this.toDomain(row);
  }

  private toDomain(row: typeof settings.$inferSelect): SettingsData {
    return Settings.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof settings.$inferSelect): SettingsData {
    return {
      id: row.id,
      tenantId: row.tenantId,
      company: (row.company as Record<string, unknown>) ?? {},
      currencies: (row.currencies as unknown[]) ?? [],
      paymentMethods: (row.paymentMethods as unknown[]) ?? [],
      taxes: (row.taxes as unknown[]) ?? [],
      units: (row.units as unknown[]) ?? [],
      warehouses: (row.warehouses as unknown[]) ?? [],
      printing: (row.printing as Record<string, unknown>) ?? {},
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
