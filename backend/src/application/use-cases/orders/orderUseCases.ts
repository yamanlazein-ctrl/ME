import type {
  IOrderRepository,
  OrderFilter,
  PendingConflict,
  PendingConflictLine,
} from "../../ports/IOrderRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { OrderData, CreateOrderInput } from "../../../domain/entities/Order.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createOrderUseCase(
  repo: IOrderRepository,
  input: CreateOrderInput,
  autoCode: string | undefined,
  ctx: TenantContext,
): Promise<Result<OrderData>> {
  if (!input.customerNameSnapshot?.trim()) return { ok: false, error: "اسم العميل مطلوب" };
  if (!input.items?.length) return { ok: false, error: "يجب إضافة بند واحد على الأقل" };
  try {
    return { ok: true, data: await repo.create(input, autoCode, ctx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل إنشاء الطلب";
    return { ok: false, error: msg };
  }
}

export async function updateOrderUseCase(
  repo: IOrderRepository,
  id: string,
  input: Partial<CreateOrderInput>,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<OrderData>> {
  try {
    // P0-001: optimistic concurrency check — expectedVersion is REQUIRED
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
      };
    }
    return { ok: true, data: await repo.update(id, input, ctx, expectedVersion) };
  } catch (e) {
    return { ok: false, error: "فشل تحديث الطلب" };
  }
}

export async function findOrderUseCase(
  repo: IOrderRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: OrderData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function findOrderByCodeUseCase(
  repo: IOrderRepository,
  code: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: OrderData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findByCode(code, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث بالكود" };
  }
}

export async function listOrdersUseCase(
  repo: IOrderRepository,
  filter: OrderFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<OrderData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الطلبات" };
  }
}

export async function cancelOrderUseCase(
  repo: IOrderRepository,
  id: string,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<OrderData>> {
  try {
    // P0-001: optimistic concurrency check — expectedVersion is REQUIRED
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
      };
    }
    return { ok: true, data: await repo.cancel(id, ctx, expectedVersion) };
  } catch (e) {
    return { ok: false, error: "فشل إلغاء الطلب" };
  }
}

export async function fulfillOrderUseCase(
  repo: IOrderRepository,
  id: string,
  invoiceId: string,
  ctx: TenantContext,
): Promise<Result<OrderData>> {
  try {
    return { ok: true, data: await repo.fulfill(id, invoiceId, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تنفيذ الطلب" };
  }
}

export async function findPendingConflictsUseCase(
  repo: IOrderRepository,
  lines: PendingConflictLine[],
  ctx: TenantContext,
): Promise<Result<PendingConflict[]>> {
  try {
    return { ok: true, data: await repo.findPendingConflicts(lines, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل التحقق من الطلبيات المعلّقة" };
  }
}
