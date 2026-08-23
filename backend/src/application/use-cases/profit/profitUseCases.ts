import type { IProfitRepository } from "../../ports/IProfitRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { ProfitSummary, ProfitDetails, ProfitQuery } from "../../../domain/entities/Profit.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getProfitSummaryUseCase(
  repo: IProfitRepository,
  query: ProfitQuery,
  ctx: TenantContext,
): Promise<Result<ProfitSummary>> {
  try {
    return { ok: true, data: await repo.getSummary(query, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل حساب صافي الربح" };
  }
}

export async function getProfitDetailsUseCase(
  repo: IProfitRepository,
  query: ProfitQuery,
  ctx: TenantContext,
): Promise<Result<ProfitDetails>> {
  try {
    return { ok: true, data: await repo.getDetails(query, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض تفاصيل الربح" };
  }
}
