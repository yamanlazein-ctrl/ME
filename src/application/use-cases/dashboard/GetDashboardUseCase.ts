import { TenantContext } from "@/domain/types";
import { IDashboardRepository, DashboardDataDTO } from "@/application/ports/IDashboardRepository";

export class GetDashboardUseCase {
  constructor(private readonly dashboard: IDashboardRepository) {}

  execute(ctx: TenantContext): Promise<DashboardDataDTO> {
    return this.dashboard.getDashboardData(ctx);
  }
}
