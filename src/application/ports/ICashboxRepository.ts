import type { TenantContext, UUID, Currency } from "@/domain/types";

export type ManualMovementType =
  "capital" | "withdrawal" | "transfer" | "adjustment" | "correction";
export type MovementDirection = "in" | "out";

export interface ManualMovementDTO {
  id: UUID;
  tenantId: UUID;
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency: Currency;
  description: string;
  notesInternal?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface DailyClosingDTO {
  id: UUID;
  tenantId: UUID;
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  expected: number;
  counted: number;
  difference: number;
  currency: Currency;
  closedAt: string;
  closedBy: string;
}

export interface CashboxStateDTO {
  openingBalance: number;
  openingDate: string;
  currency: Currency;
  isLocked: boolean;
  lastClosing: DailyClosingDTO | null;
}

export interface CreateManualMovementInput {
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency: Currency;
  description: string;
  notesInternal?: string;
}

export interface CloseDayInput {
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  counted: number;
  currency: Currency;
}

export interface DayCashFlowDTO {
  in: number;
  out: number;
}

export interface ICashboxRepository {
  getState(ctx: TenantContext): Promise<CashboxStateDTO>;
  setOpeningBalance(
    balance: number,
    date: string,
    currency: Currency,
    ctx: TenantContext,
  ): Promise<void>;
  cashBalanceOn(
    date: string,
    ctx: TenantContext,
    currency?: string,
  ): Promise<number>;
  cashMovementsOn(date: string, ctx: TenantContext): Promise<DayCashFlowDTO>;
  isDayLocked(date: string, ctx: TenantContext): Promise<boolean>;
  listManualMovements(ctx: TenantContext): Promise<ManualMovementDTO[]>;
  addManualMovement(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<ManualMovementDTO>;
  deleteManualMovement(id: UUID, ctx: TenantContext): Promise<void>;
  closeDay(input: CloseDayInput, ctx: TenantContext): Promise<DailyClosingDTO>;
  listClosings(ctx: TenantContext): Promise<DailyClosingDTO[]>;
  lastClosing(ctx: TenantContext): Promise<DailyClosingDTO | null>;
}
