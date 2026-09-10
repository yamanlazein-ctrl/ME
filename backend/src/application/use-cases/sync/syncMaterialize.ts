import type { DB } from "../../../infrastructure/orm/drizzle.js";
import type { IInvoiceRepository } from "../../ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../ports/IVoucherRepository.js";
import type { IReturnRepository } from "../../ports/IReturnRepository.js";
import type { IOrderRepository } from "../../ports/IOrderRepository.js";
import type { IExpenseRepository } from "../../ports/IExpenseRepository.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type {
  CreateInvoiceInput,
  UpdateInvoiceInput,
} from "../../../domain/entities/Invoice.js";
import type { CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { CreateReturnInput } from "../../../domain/entities/Return.js";
import type { CreateOrderInput } from "../../../domain/entities/Order.js";
import type { CreateExpenseInput } from "../../../domain/entities/Expense.js";
import {
  cancelInvoiceUseCase,
  createInvoiceUseCase,
  updateInvoiceUseCase,
} from "../invoices/invoiceUseCases.js";
import { createVoucherUseCase } from "../vouchers/voucherUseCases.js";
import {
  cancelReturnUseCase,
  createReturnUseCase,
} from "../returns/returnUseCases.js";
import {
  cancelOrderUseCase,
  createOrderUseCase,
} from "../orders/orderUseCases.js";
import {
  cancelExpenseUseCase,
  createExpenseUseCase,
} from "../expenses/expenseUseCases.js";
import {
  ensureInvoiceSyncDependencies,
  parseDependenciesPayload,
  type InvoiceSyncDependencies,
  type SyncPartySnapshot,
  type SyncFabricSnapshot,
  type SyncColorSnapshot,
  type SyncRollSnapshot,
} from "./syncDependencySnapshots.js";

export type SyncMaterializeRepos = {
  invoiceRepo: IInvoiceRepository;
  voucherRepo: IVoucherRepository;
  returnRepo: IReturnRepository;
  orderRepo: IOrderRepository;
  expenseRepo: IExpenseRepository;
  auditRepo: IAuditRepository;
};

export type MaterializeResult = {
  status: "created" | "exists" | "skipped" | "failed";
  error?: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function replayCtxFromPayload(
  payload: Record<string, unknown>,
  ctx: TenantContext,
): TenantContext {
  const actorUserId =
    typeof payload.actorUserId === "string" && isUuid(payload.actorUserId)
      ? payload.actorUserId
      : ctx.userId;
  const actorUserName =
    typeof payload.actorUserName === "string" ? payload.actorUserName : ctx.userName;
  const actorRole =
    payload.actorRole === "admin" ||
    payload.actorRole === "accountant" ||
    payload.actorRole === "warehouse" ||
    payload.actorRole === "viewer"
      ? payload.actorRole
      : ctx.userRole;
  return {
    ...ctx,
    userId: actorUserId,
    userName: actorUserName,
    userRole: actorRole,
    syncDeviceId: null,
  };
}

async function ensureDeps(
  database: DB,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult | null> {
  const deps = parseDependenciesPayload(payload);
  if (!deps) return null;
  try {
    await ensureInvoiceSyncDependencies(database, deps, ctx);
    return null;
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "فشل تجهيز البيانات المرتبطة",
    };
  }
}

export async function materializeSyncUnit(
  database: DB,
  repos: SyncMaterializeRepos,
  unit: {
    entityType: string;
    operation: string;
    payload: Record<string, unknown>;
  },
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const { entityType, operation, payload } = unit;

  if (entityType === "invoice" && operation === "create") {
    return materializeInvoiceCreate(database, repos, payload, ctx);
  }
  if (entityType === "invoice" && operation === "update") {
    return materializeInvoiceUpdate(database, repos, payload, ctx);
  }
  if (entityType === "invoice" && operation === "cancel") {
    return materializeInvoiceCancel(repos, payload, ctx);
  }
  if (entityType === "voucher" && operation === "create") {
    return materializeVoucherCreate(database, repos, payload, ctx);
  }
  if (entityType === "return" && operation === "create") {
    return materializeReturnCreate(database, repos, payload, ctx);
  }
  if (entityType === "return" && operation === "cancel") {
    return materializeReturnCancel(repos, payload, ctx);
  }
  if (entityType === "order" && operation === "create") {
    return materializeOrderCreate(database, repos, payload, ctx);
  }
  if (entityType === "order" && operation === "cancel") {
    return materializeOrderCancel(repos, payload, ctx);
  }
  if (entityType === "expense" && operation === "create") {
    return materializeExpenseCreate(repos, payload, ctx);
  }
  if (entityType === "expense" && operation === "cancel") {
    return materializeExpenseCancel(repos, payload, ctx);
  }
  if (
    (entityType === "party" ||
      entityType === "fabric" ||
      entityType === "color" ||
      entityType === "roll") &&
    operation === "create"
  ) {
    return materializeMasterCreate(database, entityType, payload, ctx);
  }
  return { status: "skipped", error: `unsupported sync unit ${entityType}/${operation}` };
}

async function materializeInvoiceCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  const invoiceNumber =
    typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : null;
  const invoiceType =
    typeof payload.invoiceType === "string" ? payload.invoiceType : null;

  if (invoiceId) {
    const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
    if (existing) return { status: "exists" };
  }
  if (invoiceNumber && invoiceType) {
    const byNumber = await repos.invoiceRepo.findByNumber(invoiceNumber, invoiceType, ctx);
    if (byNumber) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "skipped", error: "missing createInput in sync payload" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateInvoiceInput),
      preAllocatedNumber: invoiceNumber ?? undefined,
      preAllocatedId: invoiceId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeInvoiceUpdate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  if (!invoiceId) return { status: "skipped", error: "missing invoiceId" };

  const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
  if (!existing) return { status: "failed", error: "الفاتورة غير موجودة للتعديل" };
  if (existing.status === "cancelled") {
    return { status: "failed", error: "لا يمكن تعديل فاتورة ملغاة" };
  }

  const updateInput = payload.updateInput;
  if (!updateInput || typeof updateInput !== "object") {
    return { status: "skipped", error: "missing updateInput" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const updated = await updateInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    invoiceId,
    updateInput as UpdateInvoiceInput,
    replayCtxFromPayload(payload, ctx),
  );
  if (!updated.ok) return { status: "failed", error: updated.error };
  return { status: "created" };
}

async function materializeInvoiceCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId)
      ? payload.invoiceId
      : null;
  if (!invoiceId) return { status: "skipped", error: "missing invoiceId" };

  const existing = await repos.invoiceRepo.findById(invoiceId, ctx);
  if (!existing) return { status: "failed", error: "الفاتورة غير موجودة للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelInvoiceUseCase(
    repos.invoiceRepo,
    repos.auditRepo,
    invoiceId,
    replay.userId,
    replay,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeVoucherCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const voucherId =
    typeof payload.voucherId === "string" && isUuid(payload.voucherId)
      ? payload.voucherId
      : null;
  const voucherNumber =
    typeof payload.voucherNumber === "string" ? payload.voucherNumber : null;

  if (voucherId) {
    const existing = await repos.voucherRepo.findById(voucherId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "skipped", error: "missing createInput in voucher payload" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createVoucherUseCase(
    repos.voucherRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateVoucherInput),
      preAllocatedNumber: voucherNumber ?? undefined,
      preAllocatedId: voucherId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeReturnCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const returnId =
    typeof payload.returnId === "string" && isUuid(payload.returnId) ? payload.returnId : null;
  if (returnId) {
    const existing = await repos.returnRepo.findById(returnId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object") {
    return { status: "skipped", error: "missing createInput in return payload" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const returnNumber =
    typeof payload.returnNumber === "string" ? payload.returnNumber : null;

  const created = await createReturnUseCase(
    repos.returnRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateReturnInput),
      preAllocatedNumber: returnNumber ?? undefined,
      preAllocatedId: returnId ?? undefined,
    },
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeReturnCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const returnId =
    typeof payload.returnId === "string" && isUuid(payload.returnId) ? payload.returnId : null;
  if (!returnId) return { status: "skipped", error: "missing returnId" };

  const existing = await repos.returnRepo.findById(returnId, ctx);
  if (!existing) return { status: "failed", error: "المرتجع غير موجود للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelReturnUseCase(
    repos.returnRepo,
    repos.auditRepo,
    returnId,
    replay.userId,
    replay,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeOrderCreate(
  database: DB,
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const orderId =
    typeof payload.orderId === "string" && isUuid(payload.orderId) ? payload.orderId : null;
  const orderCode = typeof payload.orderCode === "string" ? payload.orderCode : null;

  if (orderId) {
    const existing = await repos.orderRepo.findById(orderId, ctx);
    if (existing) return { status: "exists" };
  }
  if (orderCode) {
    const byCode = await repos.orderRepo.findByCode(orderCode, ctx);
    if (byCode) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object" || !orderCode) {
    return { status: "skipped", error: "missing createInput/orderCode" };
  }

  const depErr = await ensureDeps(database, payload, ctx);
  if (depErr) return depErr;

  const created = await createOrderUseCase(
    repos.orderRepo,
    {
      ...(createInput as CreateOrderInput),
      preAllocatedId: orderId ?? undefined,
    },
    orderCode,
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeOrderCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const orderId =
    typeof payload.orderId === "string" && isUuid(payload.orderId) ? payload.orderId : null;
  if (!orderId) return { status: "skipped", error: "missing orderId" };

  const existing = await repos.orderRepo.findById(orderId, ctx);
  if (!existing) return { status: "failed", error: "الطلبية غير موجودة للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const result = await cancelOrderUseCase(
    repos.orderRepo,
    orderId,
    replayCtxFromPayload(payload, ctx),
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeExpenseCreate(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const expenseId =
    typeof payload.expenseId === "string" && isUuid(payload.expenseId)
      ? payload.expenseId
      : null;
  const expenseNumber =
    typeof payload.expenseNumber === "string" ? payload.expenseNumber : null;

  if (expenseId) {
    const existing = await repos.expenseRepo.findById(expenseId, ctx);
    if (existing) return { status: "exists" };
  }

  const createInput = payload.createInput;
  if (!createInput || typeof createInput !== "object" || !expenseNumber) {
    return { status: "skipped", error: "missing createInput/expenseNumber" };
  }

  const created = await createExpenseUseCase(
    repos.expenseRepo,
    repos.auditRepo,
    {
      ...(createInput as CreateExpenseInput),
      preAllocatedId: expenseId ?? undefined,
    },
    expenseNumber,
    replayCtxFromPayload(payload, ctx),
  );
  if (!created.ok) return { status: "failed", error: created.error };
  return { status: "created" };
}

async function materializeExpenseCancel(
  repos: SyncMaterializeRepos,
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const expenseId =
    typeof payload.expenseId === "string" && isUuid(payload.expenseId)
      ? payload.expenseId
      : null;
  if (!expenseId) return { status: "skipped", error: "missing expenseId" };

  const existing = await repos.expenseRepo.findById(expenseId, ctx);
  if (!existing) return { status: "failed", error: "المصروف غير موجود للإلغاء" };
  if (existing.status === "cancelled") return { status: "exists" };

  const replay = replayCtxFromPayload(payload, ctx);
  const result = await cancelExpenseUseCase(
    repos.expenseRepo,
    repos.auditRepo,
    expenseId,
    replay.userId,
    replay,
  );
  if (!result.ok) return { status: "failed", error: result.error };
  return { status: "created" };
}

async function materializeMasterCreate(
  database: DB,
  entityType: "party" | "fabric" | "color" | "roll",
  payload: Record<string, unknown>,
  ctx: TenantContext,
): Promise<MaterializeResult> {
  const snapshot = payload.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return { status: "skipped", error: "missing snapshot" };
  }
  const snap = snapshot as Record<string, unknown>;
  const deps: InvoiceSyncDependencies = {
    parties: [],
    fabrics: [],
    colors: [],
    rolls: [],
  };

  if (entityType === "party") {
    deps.parties = [snap as unknown as SyncPartySnapshot];
  } else if (entityType === "fabric") {
    deps.fabrics = [snap as unknown as SyncFabricSnapshot];
  } else if (entityType === "color") {
    deps.colors = [snap as unknown as SyncColorSnapshot];
  } else {
    deps.rolls = [snap as unknown as SyncRollSnapshot];
  }

  try {
    await ensureInvoiceSyncDependencies(database, deps, ctx);
    return { status: "created" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "فشل مزامنة السجل الأساسي",
    };
  }
}
