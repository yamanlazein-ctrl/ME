import type { ISettingsRepository } from "../../ports/ISettingsRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { SettingsData } from "../../../domain/entities/Settings.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getSettingsUseCase(
  repo: ISettingsRepository,
  ctx: TenantContext,
): Promise<Result<SettingsData | null>> {
  try {
    return { ok: true, data: await repo.getSettings(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل جلب الإعدادات" };
  }
}

export async function updateSettingsUseCase(
  repo: ISettingsRepository,
  section: string,
  value: unknown,
  ctx: TenantContext,
): Promise<Result<SettingsData>> {
  try {
    return { ok: true, data: await repo.upsertSection(section, value, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحديث الإعدادات" };
  }
}
