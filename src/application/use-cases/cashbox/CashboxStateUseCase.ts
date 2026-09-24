import { TenantContext, UUID, Currency } from "@/domain/types";
import { ICashboxRepository } from "@/application/ports/ICashboxRepository";

import { localToday } from "@/lib/localDate";
export class CashboxStateUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  getState(ctx: TenantContext) {
    return this.cashbox.getState(ctx);
  }

  cashBalanceOn(date: string, ctx: TenantContext, currency?: string) {
    return this.cashbox.cashBalanceOn(date, ctx, currency);
  }

  currentBalance(ctx: TenantContext, currency?: string) {
    const today = localToday();
    return this.cashbox.cashBalanceOn(today, ctx, currency);
  }

  isDayLocked(date: string, ctx: TenantContext) {
    return this.cashbox.isDayLocked(date, ctx);
  }

  listClosings(ctx: TenantContext) {
    return this.cashbox.listClosings(ctx);
  }

  lastClosing(ctx: TenantContext) {
    return this.cashbox.lastClosing(ctx);
  }

  deleteManualMovement(id: UUID, ctx: TenantContext) {
    return this.cashbox.deleteManualMovement(id, ctx);
  }

  setOpeningBalance(balance: number, date: string, currency: Currency, ctx: TenantContext) {
    return this.cashbox.setOpeningBalance(balance, date, currency, ctx);
  }
}
