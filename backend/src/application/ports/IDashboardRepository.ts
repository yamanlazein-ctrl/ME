import type { TenantContext } from "../../domain/types/index.js";
import type { DashboardData } from "../../domain/entities/Dashboard.js";

export interface IDashboardRepository {
  getDashboard(ctx: TenantContext): Promise<DashboardData>;
}
