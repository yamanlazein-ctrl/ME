import type { TenantContext, UUID } from "../../domain/types/index.js";
import type {
  CashboxState,
  DayCloseData,
  ManualMovementData,
  CreateManualMovementInput,
  CreateDayCloseInput,
} from "../../domain/entities/Cashbox.js";

export interface ICashboxRepository {
  getState(ctx: TenantContext): Promise<CashboxState>;
  setOpeningBalance(
    amount: number,
    date: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<void>;
  addManualMovement(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<ManualMovementData>;
  deleteManualMovement(id: UUID, ctx: TenantContext): Promise<void>;
  listManualMovements(ctx: TenantContext): Promise<ManualMovementData[]>;
  isDayLocked(date: string, ctx: TenantContext): Promise<boolean>;
  closeDay(input: CreateDayCloseInput, ctx: TenantContext): Promise<DayCloseData>;
  getLastClosing(ctx: TenantContext): Promise<DayCloseData | null>;
  getClosings(ctx: TenantContext): Promise<DayCloseData[]>;
}
