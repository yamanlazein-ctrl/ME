import { TenantContext, UUID, Currency } from "@/domain/types";
import type {
  ICashboxRepository,
  CashboxStateDTO,
  ManualMovementDTO,
  DailyClosingDTO,
  CreateManualMovementInput,
  CloseDayInput,
  DayCashFlowDTO,
} from "@/application/ports/ICashboxRepository";
import type {
  ManualMovementDTO as ContractManualMovementDTO,
  DailyClosingDTO as ContractDailyClosingDTO,
} from "@/contracts/cashbox";
import { CashboxApiService } from "@/infrastructure/api";

function toPortMovement(dto: ContractManualMovementDTO): ManualMovementDTO {
  return { ...dto, tenantId: "" as UUID, currency: dto.currency as Currency };
}

function toPortClosing(dto: ContractDailyClosingDTO): DailyClosingDTO {
  return { ...dto, tenantId: "" as UUID, currency: dto.currency as Currency };
}

export class ApiCashboxRepository implements ICashboxRepository {
  constructor(private api: CashboxApiService) {}

  async getState(ctx: TenantContext): Promise<CashboxStateDTO> {
    const state = await this.api.getState();
    const s = state.session;
    return {
      openingBalance: s?.openingBalance ?? 0,
      openingDate: s?.openingDate ?? "",
      currency: (s?.currency ?? "SYP") as Currency,
      isLocked: state.isLocked,
      lastClosing: state.lastClosing ? toPortClosing(state.lastClosing) : null,
    };
  }

  async setOpeningBalance(
    balance: number,
    date: string,
    currency: Currency,
    ctx: TenantContext,
  ): Promise<void> {
    await this.api.setOpeningBalance(balance, date, currency);
  }

  async cashBalanceOn(
    date: string,
    ctx: TenantContext,
    currency?: string,
  ): Promise<number> {
    return this.api.cashBalanceOn(date, currency);
  }

  async cashMovementsOn(
    date: string,
    ctx: TenantContext,
  ): Promise<DayCashFlowDTO> {
    return this.api.cashMovementsOn(date);
  }

  async isDayLocked(date: string, ctx: TenantContext): Promise<boolean> {
    return this.api.isDayLocked(date);
  }

  async listManualMovements(ctx: TenantContext): Promise<ManualMovementDTO[]> {
    const items = await this.api.listManualMovements();
    return items.map(toPortMovement);
  }

  async addManualMovement(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<ManualMovementDTO> {
    const dto = await this.api.addManualMovement(input);
    return toPortMovement(dto);
  }

  async deleteManualMovement(id: UUID, ctx: TenantContext): Promise<void> {
    await this.api.deleteManualMovement(id);
  }

  async closeDay(
    input: CloseDayInput,
    ctx: TenantContext,
  ): Promise<DailyClosingDTO> {
    const dto = await this.api.closeDay(input);
    return toPortClosing(dto);
  }

  async listClosings(ctx: TenantContext): Promise<DailyClosingDTO[]> {
    const items = await this.api.listClosings();
    return items.map(toPortClosing);
  }

  async lastClosing(ctx: TenantContext): Promise<DailyClosingDTO | null> {
    const dto = await this.api.lastClosing();
    return dto ? toPortClosing(dto) : null;
  }
}
