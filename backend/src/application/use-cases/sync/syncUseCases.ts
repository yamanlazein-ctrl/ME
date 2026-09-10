import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../../../infrastructure/config/env.js";
import { logger } from "../../../infrastructure/config/logger.js";
import { db, type DB } from "../../../infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { syncState } from "../../../infrastructure/orm/schemas/sync-state.table.js";
import type { ISyncOutboxRepository } from "../../ports/ISyncOutboxRepository.js";
import type { ISyncInboxRepository, SyncInboxRow } from "../../ports/ISyncInboxRepository.js";
import type { ISyncResourceClaimRepository } from "../../ports/ISyncResourceClaimRepository.js";
import type { INotificationRepository } from "../../ports/INotificationRepository.js";
import type { IInvoiceRepository } from "../../ports/IInvoiceRepository.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type { CreateInvoiceInput } from "../../../domain/entities/Invoice.js";
import { cancelInvoiceUseCase } from "../invoices/invoiceUseCases.js";
import { type InvoiceSyncDependencies } from "./syncDependencySnapshots.js";
import { materializeSyncUnit, type SyncMaterializeRepos } from "./syncMaterialize.js";

export async function enqueueInvoiceCreate(
  outbox: ISyncOutboxRepository,
  invoice: {
    id: string;
    type: string;
    number: string;
    partyId?: string;
    lines?: Array<{ rollId: string; quantityKg: number }>;
  },
  createInput: CreateInvoiceInput,
  ctx: TenantContext,
  syncDeviceId: string | null,
  opId?: string,
  dependencies?: InvoiceSyncDependencies | null,
) {
  const rollIds = (invoice.lines ?? createInput.lines ?? [])
    .map((l) => l.rollId)
    .filter((id): id is string => Boolean(id) && isUuid(id));

  return outbox.enqueue({
    tenantId: ctx.tenantId,
    syncDeviceId: syncDeviceId && isUuid(syncDeviceId) ? syncDeviceId : null,
    opId: opId && isUuid(opId) ? opId : randomUUID(),
    entityType: "invoice",
    entityId: invoice.id,
    operation: "create",
    payload: {
      invoiceId: invoice.id,
      invoiceType: invoice.type,
      invoiceNumber: invoice.number,
      partyId: invoice.partyId ?? createInput.partyId,
      rollIds,
      lines: invoice.lines ?? createInput.lines.map((l) => ({
        rollId: l.rollId,
        quantityKg: l.quantityKg,
      })),
      createInput,
      dependencies: dependencies ?? null,
      preAllocated: true,
      actorUserId: ctx.userId,
      actorRole: ctx.userRole,
      actorUserName: ctx.userName,
    },
  });
}

export async function getSyncStatus(
  outbox: ISyncOutboxRepository,
  tenantId: UUID,
): Promise<{
  pendingCount: number;
  hubConfigured: boolean;
  hubUrl: string | null;
  lastPullAt: string | null;
}> {
  const pendingCount = await outbox.countPending(tenantId);
  const hubUrl = config.CENTRAL_SYNC_URL?.replace(/\/+$/, "") || null;
  const lastPullAt = await getLastPullAt(tenantId);
  return {
    pendingCount,
    hubConfigured: Boolean(hubUrl),
    hubUrl,
    lastPullAt: lastPullAt?.toISOString() ?? null,
  };
}

export async function runLocalSyncPush(
  outbox: ISyncOutboxRepository,
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  notificationRepo: INotificationRepository,
  ctx: TenantContext,
  authHeader: string | undefined,
): Promise<{
  pushed: number;
  failed: number;
  rejected: number;
  skipped: boolean;
  reason?: string;
}> {
  const hub = config.CENTRAL_SYNC_URL?.replace(/\/+$/, "");
  if (!hub) {
    return {
      pushed: 0,
      failed: 0,
      rejected: 0,
      skipped: true,
      reason: "CENTRAL_SYNC_URL غير مضبوط",
    };
  }

  const pending = await outbox.listPending(ctx.tenantId, 50);
  if (pending.length === 0) {
    return { pushed: 0, failed: 0, rejected: 0, skipped: false };
  }

  await outbox.markPushing(
    pending.map((p) => p.id),
    ctx.tenantId,
  );

  let pushed = 0;
  let failed = 0;
  let rejected = 0;
  for (const unit of pending) {
    try {
      const res = await fetch(`${hub}/api/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          opId: unit.opId,
          syncDeviceId: unit.syncDeviceId,
          entityType: unit.entityType,
          entityId: unit.entityId,
          operation: unit.operation,
          payload: unit.payload,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let parsed: {
          code?: string;
          message?: string;
          conflictOpId?: string;
          conflicts?: unknown;
        } = {};
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          // plain text
        }
        const detail = parsed.message || `hub ${res.status}: ${text.slice(0, 200)}`;

        if (res.status === 409 || parsed.code === "SYNC_CONFLICT") {
          await outbox.markRejected(unit.id, ctx.tenantId, detail);
          rejected += 1;
          await rollbackRejectedUnitLocally(
            invoiceRepo,
            auditRepo,
            notificationRepo,
            unit,
            ctx,
            detail,
            parsed.conflictOpId ?? null,
          );
          continue;
        }

        if (res.status >= 500) {
          await outbox.resetToPending(unit.id, ctx.tenantId, detail);
        } else {
          await outbox.markRejected(unit.id, ctx.tenantId, detail);
        }
        failed += 1;
        continue;
      }
      await outbox.markSynced(unit.id, ctx.tenantId);
      pushed += 1;
    } catch (err) {
      logger.warn({ err, opId: unit.opId }, "sync push unit failed");
      await outbox.resetToPending(
        unit.id,
        ctx.tenantId,
        err instanceof Error ? err.message : "push failed",
      );
      failed += 1;
    }
  }

  return { pushed, failed, rejected, skipped: false };
}

/** Pull applied units from hub and materialize locally. */
export async function runLocalSyncPull(
  database: DB,
  repos: SyncMaterializeRepos,
  ctx: TenantContext,
  authHeader: string | undefined,
  syncDeviceId: string | null,
): Promise<{ pulled: number; applied: number; skipped: number; failed: number }> {
  const hub = config.CENTRAL_SYNC_URL?.replace(/\/+$/, "");
  if (!hub || !authHeader) {
    return { pulled: 0, applied: 0, skipped: 0, failed: 0 };
  }

  const after = await getLastPullAt(ctx.tenantId);
  const qs = new URLSearchParams();
  if (after) qs.set("after", after.toISOString());
  if (syncDeviceId) qs.set("excludeSyncDeviceId", syncDeviceId);
  qs.set("limit", "50");

  const res = await fetch(`${hub}/api/sync/pull?${qs.toString()}`, {
    method: "GET",
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hub pull ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    items: Array<{
      opId: string;
      syncDeviceId: string | null;
      entityType: string;
      entityId: string;
      operation: string;
      payload: Record<string, unknown>;
      receivedAt: string;
      appliedAt: string | null;
    }>;
  };

  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let maxReceived: Date | null = after;

  for (const unit of body.items ?? []) {
    const receivedAt = new Date(unit.receivedAt);
    if (!maxReceived || receivedAt > maxReceived) maxReceived = receivedAt;

    try {
      const result = await materializeSyncUnit(
        database,
        repos,
        unit,
        ctx,
      );
      if (result.status === "created" || result.status === "exists") {
        applied += 1;
      } else if (result.status === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
        logger.warn({ opId: unit.opId, error: result.error }, "pull materialize failed");
      }
    } catch (err) {
      failed += 1;
      logger.warn({ err, opId: unit.opId }, "pull unit apply failed");
    }
  }

  if (maxReceived && (body.items?.length ?? 0) > 0) {
    await setLastPullAt(ctx.tenantId, maxReceived);
  }

  return { pulled: body.items?.length ?? 0, applied, skipped, failed };
}

/**
 * Hub receive with first-write-wins on shared resources, then use-case replay.
 */
export async function receiveSyncPush(
  inbox: ISyncInboxRepository,
  claims: ISyncResourceClaimRepository,
  notificationRepo: INotificationRepository,
  repos: SyncMaterializeRepos,
  database: DB,
  input: {
    tenantId: UUID;
    syncDeviceId?: string | null;
    opId: string;
    entityType: string;
    entityId: string;
    operation: string;
    payload: Record<string, unknown>;
    hubCtx: TenantContext;
  },
): Promise<
  | {
      accepted: true;
      created: boolean;
      materialized: boolean;
      row: SyncInboxRow;
    }
  | {
      accepted: false;
      conflict: true;
      message: string;
      conflictOpId: string | null;
      conflicts: unknown;
      row: SyncInboxRow;
    }
> {
  const existing = await inbox.receive({
    tenantId: input.tenantId,
    syncDeviceId: input.syncDeviceId && isUuid(input.syncDeviceId) ? input.syncDeviceId : null,
    opId: input.opId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    payload: input.payload,
  });

  if (!existing.created) {
    if (existing.row.status === "rejected") {
      return {
        accepted: false,
        conflict: true,
        message: existing.row.rejectReason || "رُفضت وحدة المزامنة سابقاً بسبب تعارض",
        conflictOpId: existing.row.conflictOpId,
        conflicts: existing.row.conflictDetail,
        row: existing.row,
      };
    }
    if (existing.row.status === "applied") {
      return { accepted: true, created: false, materialized: true, row: existing.row };
    }
    // Retry materialization for previously accepted-but-not-applied units.
    const mat = await tryMaterializeAcceptedUnit(
      inbox,
      repos,
      database,
      existing.row,
      input.hubCtx,
    );
    return {
      accepted: true,
      created: false,
      materialized: mat,
      row: (await inbox.findByOpId(input.tenantId, input.opId)) ?? existing.row,
    };
  }

  const resources = extractConflictResources(input.entityType, input.operation, input.payload);
  if (resources.length > 0) {
    const claimResult = await claims.tryClaimAll({
      tenantId: input.tenantId,
      opId: input.opId,
      syncDeviceId: input.syncDeviceId && isUuid(input.syncDeviceId) ? input.syncDeviceId : null,
      entityType: input.entityType,
      entityId: input.entityId,
      resources,
    });

    if (!claimResult.ok) {
      const winner = claimResult.conflicts[0];
      const message = buildConflictMessage(input.payload, winner);
      const conflictDetail = {
        conflicts: claimResult.conflicts.map((c) => ({
          resourceType: c.resourceType,
          resourceId: c.resourceId,
          claimedByOpId: c.claimedByOpId,
          claimedByDeviceId: c.claimedByDeviceId,
          entityType: c.entityType,
          entityId: c.entityId,
          claimedAt: c.claimedAt.toISOString(),
        })),
        loserOpId: input.opId,
        loserEntityId: input.entityId,
        loserInvoiceNumber:
          typeof input.payload.invoiceNumber === "string" ? input.payload.invoiceNumber : null,
      };

      const rejected = await inbox.markRejected(
        input.tenantId,
        input.opId,
        message,
        winner?.claimedByOpId ?? null,
        conflictDetail,
      );

      const actorUserId =
        typeof input.payload.actorUserId === "string" && isUuid(input.payload.actorUserId)
          ? input.payload.actorUserId
          : null;
      if (actorUserId) {
        try {
          await notificationRepo.create(
            {
              userId: actorUserId,
              title: "رُفضت مزامنة بسبب تعارض",
              detail: message,
              kind: "sync",
              severity: "warning",
              targetPath:
                input.entityType === "invoice" ? `/invoices/${input.entityId}` : undefined,
            },
            {
              ...input.hubCtx,
              userId: actorUserId,
            },
          );
        } catch (err) {
          logger.warn({ err }, "failed to notify sync conflict loser");
        }
      }

      return {
        accepted: false,
        conflict: true,
        message,
        conflictOpId: winner?.claimedByOpId ?? null,
        conflicts: conflictDetail.conflicts,
        row: rejected ?? existing.row,
      };
    }
  }

  const materialized = await tryMaterializeAcceptedUnit(
    inbox,
    repos,
    database,
    existing.row,
    input.hubCtx,
  );
  return {
    accepted: true,
    created: true,
    materialized,
    row: (await inbox.findByOpId(input.tenantId, input.opId)) ?? existing.row,
  };
}

async function tryMaterializeAcceptedUnit(
  inbox: ISyncInboxRepository,
  repos: SyncMaterializeRepos,
  database: DB,
  row: SyncInboxRow,
  ctx: TenantContext,
): Promise<boolean> {
  const result = await materializeSyncUnit(
    database,
    repos,
    {
      entityType: row.entityType,
      operation: row.operation,
      payload: row.payload,
    },
    ctx,
  );

  if (result.status === "created" || result.status === "exists") {
    await inbox.markApplied(row.tenantId, row.opId);
    return true;
  }

  if (result.status === "skipped") {
    await inbox.markApplied(row.tenantId, row.opId);
    return true;
  }

  await inbox.setMaterializeError(row.tenantId, row.opId, {
    materializeError: result.error ?? "unknown",
    at: new Date().toISOString(),
  });
  logger.warn(
    { opId: row.opId, error: result.error },
    "hub materialize deferred — unit stays received",
  );
  return false;
}

async function rollbackRejectedUnitLocally(
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  notificationRepo: INotificationRepository,
  unit: {
    entityType: string;
    entityId: string;
    operation: string;
    payload: Record<string, unknown>;
    opId: string;
  },
  ctx: TenantContext,
  detail: string,
  conflictOpId: string | null,
) {
  if (unit.entityType === "invoice" && unit.operation === "create") {
    try {
      await cancelInvoiceUseCase(invoiceRepo, auditRepo, unit.entityId, ctx.userId, ctx);
    } catch (err) {
      logger.warn({ err, entityId: unit.entityId }, "local rollback cancel invoice failed");
    }
  }

  try {
    const invoiceNumber =
      typeof unit.payload.invoiceNumber === "string" ? unit.payload.invoiceNumber : unit.entityId;
    await notificationRepo.create(
      {
        userId: ctx.userId,
        title: "أُبطلت عملية محلية بعد رفض المزامنة",
        detail: `${detail}${conflictOpId ? ` (فازت العملية ${conflictOpId})` : ""} — المستند: ${invoiceNumber}`,
        kind: "sync",
        severity: "warning",
        targetPath: unit.entityType === "invoice" ? `/invoices/${unit.entityId}` : undefined,
      },
      ctx,
    );
  } catch (err) {
    logger.warn({ err }, "local conflict notification failed");
  }
}

function extractConflictResources(
  entityType: string,
  operation: string,
  payload: Record<string, unknown>,
): Array<{ resourceType: string; resourceId: string }> {
  if (entityType === "invoice" && (operation === "create" || operation === "update")) {
    const rollIds = Array.isArray(payload.rollIds)
      ? payload.rollIds.filter((id): id is string => typeof id === "string" && isUuid(id))
      : [];
    if (rollIds.length > 0) {
      return rollIds.map((resourceId) => ({
        resourceType: operation === "update" ? "invoice_update_roll" : "roll",
        resourceId,
      }));
    }
    if (typeof payload.invoiceId === "string" && isUuid(payload.invoiceId)) {
      return [
        {
          resourceType: operation === "update" ? "invoice_update" : "invoice",
          resourceId: payload.invoiceId,
        },
      ];
    }
  }
  if (entityType === "invoice" && operation === "cancel") {
    if (typeof payload.invoiceId === "string" && isUuid(payload.invoiceId)) {
      return [{ resourceType: "invoice_cancel", resourceId: payload.invoiceId }];
    }
  }
  if (entityType === "voucher" && operation === "create") {
    if (typeof payload.voucherId === "string" && isUuid(payload.voucherId)) {
      return [{ resourceType: "voucher", resourceId: payload.voucherId }];
    }
  }
  if (entityType === "return" && operation === "create") {
    const rollIds = Array.isArray(payload.rollIds)
      ? payload.rollIds.filter((id): id is string => typeof id === "string" && isUuid(id))
      : [];
    if (rollIds.length > 0) {
      return rollIds.map((resourceId) => ({ resourceType: "return_roll", resourceId }));
    }
    if (typeof payload.returnId === "string" && isUuid(payload.returnId)) {
      return [{ resourceType: "return", resourceId: payload.returnId }];
    }
  }
  if (entityType === "return" && operation === "cancel") {
    if (typeof payload.returnId === "string" && isUuid(payload.returnId)) {
      return [{ resourceType: "return_cancel", resourceId: payload.returnId }];
    }
  }
  if (entityType === "order" && operation === "create") {
    if (typeof payload.orderId === "string" && isUuid(payload.orderId)) {
      return [{ resourceType: "order", resourceId: payload.orderId }];
    }
  }
  if (entityType === "order" && operation === "cancel") {
    if (typeof payload.orderId === "string" && isUuid(payload.orderId)) {
      return [{ resourceType: "order_cancel", resourceId: payload.orderId }];
    }
  }
  if (entityType === "expense" && operation === "create") {
    if (typeof payload.expenseId === "string" && isUuid(payload.expenseId)) {
      return [{ resourceType: "expense", resourceId: payload.expenseId }];
    }
  }
  if (entityType === "expense" && operation === "cancel") {
    if (typeof payload.expenseId === "string" && isUuid(payload.expenseId)) {
      return [{ resourceType: "expense_cancel", resourceId: payload.expenseId }];
    }
  }
  if (
    (entityType === "party" ||
      entityType === "fabric" ||
      entityType === "color" ||
      entityType === "roll") &&
    operation === "create"
  ) {
    const snap = payload.snapshot as { id?: string } | undefined;
    if (snap?.id && isUuid(snap.id)) {
      return [{ resourceType: entityType, resourceId: snap.id }];
    }
  }
  return [];
}

function buildConflictMessage(
  payload: Record<string, unknown>,
  winner:
    | {
        claimedByOpId: string;
        entityType: string;
        entityId: string;
        claimedAt: Date;
        resourceType: string;
        resourceId: string;
      }
    | undefined,
): string {
  const loserNumber =
    typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : "مستند محلي";
  if (!winner) {
    return `رُفضت مزامنة «${loserNumber}» لأن جهازاً آخر سبق بمزامنة نفس الموارد`;
  }
  return (
    `رُفضت مزامنة «${loserNumber}» بالكامل (أول واصل يفوز). ` +
    `سبقها ${winner.entityType} ${winner.entityId} على المورد ${winner.resourceType}:${winner.resourceId} ` +
    `في ${winner.claimedAt.toISOString()}`
  );
}

async function getLastPullAt(tenantId: string): Promise<Date | null> {
  return runWithTenantContext({ tenantId }, async () => {
    const [row] = await db
      .select()
      .from(syncState)
      .where(eq(syncState.tenantId, tenantId))
      .limit(1);
    return row?.lastPullAt ?? null;
  });
}

async function setLastPullAt(tenantId: string, at: Date): Promise<void> {
  await runWithTenantContext({ tenantId }, async () => {
    await db
      .insert(syncState)
      .values({ tenantId, lastPullAt: at, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [syncState.tenantId],
        set: { lastPullAt: at, updatedAt: new Date() },
      });
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
