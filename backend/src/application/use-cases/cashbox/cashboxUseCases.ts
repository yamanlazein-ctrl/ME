import type { ICashboxRepository } from "../../ports/ICashboxRepository.js";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type {
  CashboxState,
  DayCloseData,
  ManualMovementData,
  CreateManualMovementInput,
  CreateDayCloseInput,
} from "../../../domain/entities/Cashbox.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function getCashboxStateUseCase(
  repo: ICashboxRepository,
  ctx: TenantContext,
): Promise<Result<CashboxState>> {
  try {
    return { ok: true, data: await repo.getState(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل جلب حالة الصندوق" };
  }
}

export async function setOpeningBalanceUseCase(
  repo: ICashboxRepository,
  amount: number,
  date: string,
  currency: string,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.setOpeningBalance(amount, date, currency, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل تعيين الرصيد الافتتاحي" };
  }
}

export async function addManualMovementUseCase(
  repo: ICashboxRepository,
  input: CreateManualMovementInput,
  ctx: TenantContext,
): Promise<Result<ManualMovementData>> {
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "المبلغ يجب أن يكون أكبر من صفر" };
  try {
    return { ok: true, data: await repo.addManualMovement(input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل إضافة حركة يدوية" };
  }
}

export async function deleteManualMovementUseCase(
  repo: ICashboxRepository,
  id: UUID,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.deleteManualMovement(id, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل حذف الحركة" };
  }
}

export async function listManualMovementsUseCase(
  repo: ICashboxRepository,
  ctx: TenantContext,
): Promise<Result<ManualMovementData[]>> {
  try {
    return { ok: true, data: await repo.listManualMovements(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الحركات" };
  }
}

export async function closeDayUseCase(
  repo: ICashboxRepository,
  input: CreateDayCloseInput,
  ctx: TenantContext,
): Promise<Result<DayCloseData>> {
  const locked = await repo.isDayLocked(input.date, ctx);
  if (locked) return { ok: false, error: "اليوم مقفل بالفعل" };
  try {
    return { ok: true, data: await repo.closeDay(input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل إقفال اليوم" };
  }
}

export async function getLastClosingUseCase(
  repo: ICashboxRepository,
  ctx: TenantContext,
): Promise<{ ok: true; data: DayCloseData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.getLastClosing(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل جلب آخر إقفال" };
  }
}

export async function getClosingsUseCase(
  repo: ICashboxRepository,
  ctx: TenantContext,
): Promise<Result<DayCloseData[]>> {
  try {
    return { ok: true, data: await repo.getClosings(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الإقفالات" };
  }
}

export async function isDayLockedUseCase(
  repo: ICashboxRepository,
  date: string,
  ctx: TenantContext,
): Promise<Result<boolean>> {
  try {
    return { ok: true, data: await repo.isDayLocked(date, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل فحص قفل اليوم" };
  }
}
