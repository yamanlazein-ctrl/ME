import type { TenantContext } from "../../domain/types/index.js";
import type { ProfitSummary, ProfitDetails, ProfitQuery } from "../../domain/entities/Profit.js";

export interface IProfitRepository {
  getSummary(query: ProfitQuery, ctx: TenantContext): Promise<ProfitSummary>;
  getDetails(query: ProfitQuery, ctx: TenantContext): Promise<ProfitDetails>;
}
