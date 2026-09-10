import { randomUUID } from "node:crypto";
import { config } from "../../../infrastructure/config/env.js";
import type { ISyncOutboxRepository } from "../../ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { CreateReturnInput } from "../../../domain/entities/Return.js";
import type { CreateOrderInput } from "../../../domain/entities/Order.js";
import type { CreateExpenseInput } from "../../../domain/entities/Expense.js";
import type { UpdateInvoiceInput } from "../../../domain/entities/Invoice.js";
import type { InvoiceSyncDependencies } from "./syncDependencySnapshots.js";

export function isSyncEnqueueEnabled(): boolean {
  return Boolean(config.DESKTOP_DEPLOY || config.CENTRAL_SYNC_URL);
}

export function syncDeviceIdFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: { syncDeviceId?: string | null };
}): string | null {
  if (req.tenantContext?.syncDeviceId) return req.tenantContext.syncDeviceId;
  const h = req.headers["x-sync-device-id"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0] ?? null;
  return null;
}

export function opIdFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const h = req.headers["idempotency-key"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function enqueueSyncUnit(
  outbox: ISyncOutboxRepository,
  input: {
    tenantId: string;
    syncDeviceId: string | null;
    opId?: string;
    entityType: string;
    entityId: string;
    operation: string;
    payload: Record<string, unknown>;
  },
) {
  return outbox.enqueue({
    tenantId: input.tenantId,
    syncDeviceId:
      input.syncDeviceId && isUuid(input.syncDeviceId) ? input.syncDeviceId : null,
    opId: input.opId && isUuid(input.opId) ? input.opId : randomUUID(),
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    payload: input.payload,
  });
}

export async function enqueueVoucherCreate(
  outbox: ISyncOutboxRepository,
  voucher: { id: string; kind: string; number: string; partyId: string },
  createInput: CreateVoucherInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "voucher",
    entityId: voucher.id,
    operation: "create",
    payload: {
      voucherId: voucher.id,
      voucherKind: voucher.kind,
      voucherNumber: voucher.number,
      partyId: voucher.partyId,
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueInvoiceCancel(
  outbox: ISyncOutboxRepository,
  invoice: { id: string; number?: string; type?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "invoice",
    entityId: invoice.id,
    operation: "cancel",
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      invoiceType: invoice.type ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueMasterCreate(
  outbox: ISyncOutboxRepository,
  entityType: "party" | "fabric" | "color" | "roll",
  entityId: string,
  snapshot: Record<string, unknown>,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType,
    entityId,
    operation: "create",
    payload: {
      snapshot,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueReturnCreate(
  outbox: ISyncOutboxRepository,
  ret: { id: string; number: string; kind: string; partyId: string },
  createInput: CreateReturnInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "return",
    entityId: ret.id,
    operation: "create",
    payload: {
      returnId: ret.id,
      returnNumber: ret.number,
      returnKind: ret.kind,
      partyId: ret.partyId,
      createInput,
      dependencies: dependencies ?? null,
      rollIds: createInput.lines.map((l) => l.rollId),
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueReturnCancel(
  outbox: ISyncOutboxRepository,
  ret: { id: string; number?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "return",
    entityId: ret.id,
    operation: "cancel",
    payload: {
      returnId: ret.id,
      returnNumber: ret.number ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueOrderCreate(
  outbox: ISyncOutboxRepository,
  order: { id: string; code: string },
  createInput: CreateOrderInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "order",
    entityId: order.id,
    operation: "create",
    payload: {
      orderId: order.id,
      orderCode: order.code,
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueOrderCancel(
  outbox: ISyncOutboxRepository,
  order: { id: string; code?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "order",
    entityId: order.id,
    operation: "cancel",
    payload: {
      orderId: order.id,
      orderCode: order.code ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueExpenseCreate(
  outbox: ISyncOutboxRepository,
  expense: { id: string; number: string },
  createInput: CreateExpenseInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "expense",
    entityId: expense.id,
    operation: "create",
    payload: {
      expenseId: expense.id,
      expenseNumber: expense.number,
      createInput,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueExpenseCancel(
  outbox: ISyncOutboxRepository,
  expense: { id: string; number?: string },
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "expense",
    entityId: expense.id,
    operation: "cancel",
    payload: {
      expenseId: expense.id,
      expenseNumber: expense.number ?? null,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function enqueueInvoiceUpdate(
  outbox: ISyncOutboxRepository,
  invoice: { id: string; number?: string; type?: string },
  updateInput: UpdateInvoiceInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  return enqueueSyncUnit(outbox, {
    tenantId: ctx.tenantId,
    syncDeviceId,
    opId,
    entityType: "invoice",
    entityId: invoice.id,
    operation: "update",
    payload: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number ?? null,
      invoiceType: invoice.type ?? null,
      updateInput,
      dependencies: dependencies ?? null,
      rollIds: updateInput.lines.map((l) => l.rollId),
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}
