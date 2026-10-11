// PORTED-FROM: src/infrastructure/repositories/PostgresSettingsRepository.ts sha256=249fece400d6876b3a0147a9f762fe2427ef1bbf02cbe9894b10b28e72c132c8
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { eq } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import type { ISettingsRepository } from "../../../application/ports/ISettingsRepository.js";
import { settings } from "../../orm/sqlite/schemas/setting.table.js";
import { Settings, type SettingsData } from "../../../domain/entities/Settings.js";
import type { TenantContext } from "../../../domain/types/index.js";

const ALLOWED_SECTIONS = [
  "company",
  "currencies",
  "paymentMethods",
  "taxes",
  "units",
  "warehouses",
  "printing",
  // SS-01: the Drive archive settings section, accepted by `PUT /settings/drive` and materialized
  // by the sync admin-snapshot path. Replicated through the hub like every other section.
  "drive",
] as const;

/** SS-01: `upsertSection` interpolates the section name into the SET clause, so a payload-supplied
 * name could write the protected `id`/`tenant_id` columns (or any future column) of the settings
 * row — re-pointing a company's settings at another tenant. Only the allowlisted sections may
 * reach the write; everything else is refused before any SQL is issued. */
function assertAllowedSection(section: string): void {
  if (!(ALLOWED_SECTIONS as readonly string[]).includes(section)) {
    throw new Error(`SETTINGS_SECTION_NOT_ALLOWED: ${section}`);
  }
}

export class SqliteSettingsRepository implements ISettingsRepository {
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
    assertAllowedSection(section);
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
      drive: (row.drive as Record<string, unknown>) ?? {},
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
