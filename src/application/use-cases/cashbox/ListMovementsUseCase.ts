import { TenantContext } from "@/domain/types";
import { ICashboxRepository, DayCashFlowDTO } from "@/application/ports/ICashboxRepository";

export class ListMovementsUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  listManual(ctx: TenantContext) {
    return this.cashbox.listManualMovements(ctx);
  }

  movementsOn(date: string, ctx: TenantContext): Promise<DayCashFlowDTO> {
    return this.cashbox.cashMovementsOn(date, ctx);
  }
}
