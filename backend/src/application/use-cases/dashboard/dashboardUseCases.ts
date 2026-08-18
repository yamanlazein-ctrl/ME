import type { IDashboardRepository } from "../../ports/IDashboardRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { DashboardData } from "../../../domain/entities/Dashboard.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getDashboardUseCase(
  repo: IDashboardRepository,
  ctx: TenantContext,
): Promise<Result<DashboardData>> {
  try {
    return { ok: true, data: await repo.getDashboard(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحميل لوحة المعلومات" };
  }
}
