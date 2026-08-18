import type { TenantContext } from "../../domain/types/index.js";
import type { SettingsData } from "../../domain/entities/Settings.js";

export interface ISettingsRepository {
  getSettings(ctx: TenantContext): Promise<SettingsData | null>;
  upsertSection(section: string, value: unknown, ctx: TenantContext): Promise<SettingsData>;
}
