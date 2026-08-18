import type { IExpenseRepository, ExpenseFilter } from "../../ports/IExpenseRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { ExpenseData, CreateExpenseInput } from "../../../domain/entities/Expense.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createExpenseUseCase(
  repo: IExpenseRepository,
  audit: IAuditRepository,
  input: CreateExpenseInput,
  autoNumber: string,
  ctx: TenantContext,
): Promise<Result<ExpenseData>> {
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "المبلغ يجب أن يكون أكبر من صفر" };
  try {
    const e = await repo.create(input, autoNumber, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "expenses",
        action: "create",
        entityType: "expense",
        entityId: e.id,
        detail: `مصروف ${e.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "expenses", action: "create", entityId: e.id, tenantId: ctx.tenantId }));
    return { ok: true, data: e };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل إنشاء المصروف" };
  }
}

export async function cancelExpenseUseCase(
  repo: IExpenseRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<Result<ExpenseData>> {
  try {
    const e = await repo.cancel(id, cancelledBy, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "expenses",
        action: "cancel",
        entityType: "expense",
        entityId: e.id,
        detail: `إلغاء مصروف ${e.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "expenses", action: "cancel", entityId: e.id, tenantId: ctx.tenantId }));
    return { ok: true, data: e };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل إلغاء المصروف" };
  }
}

export async function findExpenseUseCase(
  repo: IExpenseRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: ExpenseData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listExpensesUseCase(
  repo: IExpenseRepository,
  filter: ExpenseFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<ExpenseData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض المصاريف" };
  }
}
