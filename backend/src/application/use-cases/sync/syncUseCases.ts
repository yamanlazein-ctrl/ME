import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { logger } from "../../../infrastructure/config/logger.js";
import { db, type DB } from "../../../infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { syncState } from "../../../infrastructure/orm/schemas/sync-state.table.js";
import type { ISyncOutboxRepository } from "../../ports/ISyncOutboxRepository.js";
import type { ISyncInboxRepository, SyncInboxRow } from "../../ports/ISyncInboxRepository.js";
import type { ISyncResourceClaimRepository } from "../../ports/ISyncResourceClaimRepository.js";
import type { INotificationRepository } from "../../ports/INotificationRepository.js";
import type { IInvoiceRepository } from "../../ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../ports/IVoucherRepository.js";
import type { IReturnRepository } from "../../ports/IReturnRepository.js";
import type { IOrderRepository } from "../../ports/IOrderRepository.js";
import type { IExpenseRepository } from "../../ports/IExpenseRepository.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import type { ILedgerRepository } from "../../ports/ILedgerRepository.js";
import type { ICashboxRepository } from "../../ports/ICashboxRepository.js";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type { CreateInvoiceInput } from "../../../domain/entities/Invoice.js";
import { cancelInvoiceUseCase } from "../invoices/invoiceUseCases.js";
import { cancelVoucherUseCase } from "../vouchers/voucherUseCases.js";
import { cancelReturnUseCase } from "../returns/returnUseCases.js";
import { cancelOrderUseCase } from "../orders/orderUseCases.js";
import { cancelExpenseUseCase } from "../expenses/expenseUseCases.js";
import { cancelLedgerByReferenceUseCase } from "../ledger/ledgerUseCases.js";
import { type InvoiceSyncDependencies } from "./syncDependencySnapshots.js";
import {
  materializeSyncUnit,
  type SyncMaterializeRepos,
  type MaterializeResult,
} from "./syncMaterialize.js";

import { recordSyncConflict, resolveSyncConflictByOp } from "./syncConflicts.js";
import {
  getCentralSyncUrl,
  markHubUnreachable,
  refreshHubSession,
  resolveHubAuthHeader,
} from "./hubConfig.js";

/**
 * How many times a retryable materialization failure may repeat before the unit
 * is parked as `dead`. Retrying is correct while a dependency is still in
 * flight, but an unbounded loop means a unit can never converge and nobody is
 * ever told — the exact failure this budget makes visible.
 */
export const MATERIALIZE_MAX_ATTEMPTS = 5;

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
      lines:
        invoice.lines ??
        createInput.lines.map((l) => ({
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
  statusCounts: Record<string, number>;
  hubConfigured: boolean;
  hubUrl: string | null;
  lastPullAt: string | null;
  lastPullSeq: number | null;
}> {
  // pending + pushing: a unit abandoned mid-push is still outstanding work and
  // must not read as "0 معلّق" in the UI.
  const pendingCount = await outbox.countOutstanding(tenantId);
  const statusCounts = await outbox.countByStatus(tenantId);
  const hubUrl = getCentralSyncUrl();
  const cursor = await getPullCursor(tenantId);
  return {
    pendingCount,
    statusCounts,
    hubConfigured: Boolean(hubUrl),
    hubUrl,
    lastPullAt: cursor.lastPullAt?.toISOString() ?? null,
    lastPullSeq: cursor.lastPullSeq,
  };
}

/**
 * Repositories needed to reconcile a terminally-rejected sync unit locally.
 *
 * A rejected unit whose local record stays active is a permanent fork: the hub
 * will never accept it, but the device keeps showing it as real. Every
 * created document type therefore needs its cancel use-case wired here so a
 * rejection rolls the local record back instead of leaving it divergent.
 * Update/cancel losers cannot be auto-reverted safely (reverting user edits or
 * un-cancelling destroys intent), so they resolve to a flagged notification
 * with manual-resolution guidance — visible, never silent.
 */
export type SyncRollbackRepos = {
  voucherRepo?: IVoucherRepository;
  returnRepo?: IReturnRepository;
  orderRepo?: IOrderRepository;
  expenseRepo?: IExpenseRepository;
  ledgerRepo?: ILedgerRepository;
  cashboxRepo?: ICashboxRepository;
};

/**
 * Batch 4 / 4B — hub refusals that mean "this DEVICE has no authority", as
 * opposed to "this unit is bad". The distinction matters: a device-trust
 * refusal never judges the unit's CONTENT, so the unit must stay pending
 * (never rolled back locally) and retrying is pointless until an operator acts
 * (register the device / reinstate it / bind this user). Reported to the UI via
 * `deviceTrust` so the offline story stays explicit instead of looking like an
 * endless network failure.
 */
const DEVICE_TRUST_CODES = new Set([
  "SYNC_UNKNOWN_DEVICE",
  "SYNC_DEVICE_REVOKED",
  "SYNC_DEVICE_NOT_BOUND",
  "SYNC_DEVICE_FINGERPRINT_MISMATCH",
]);

export type SyncDeviceTrustFailure = { code: string; message: string } | null;

export async function runLocalSyncPush(
  outbox: ISyncOutboxRepository,
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  notificationRepo: INotificationRepository,
  ctx: TenantContext,
  authHeader: string | undefined,
  rollbackRepos?: SyncRollbackRepos,
): Promise<{
  pushed: number;
  failed: number;
  rejected: number;
  /**
   * Units the hub parked as `dead` (visible via hub /sync/inbox). The device
   * marks them synced — the hub owns them now and no retry can help — but
   * reports them here AND notifies the acting user, so a hub-side dead letter
   * never passes as a clean sync.
   */
  hubDead: number;
  hubDeadOps: string[];
  /**
   * True when the hub refused pushes with SYNC_UNKNOWN_DEVICE. The units stay
   * pending (their content was never judged) — the operator must register the
   * device, then the next drain succeeds. Surfaced to the UI as a
   * register-device prompt, not a silent failure count.
   */
  deviceGate: boolean;
  /**
   * 4B: WHY the device gate refused (unknown / revoked / not bound). Null when
   * the gate did not refuse. Additive to `deviceGate`, which older clients
   * already read.
   */
  deviceTrust: SyncDeviceTrustFailure;
  skipped: boolean;
  reason?: string;
}> {
  const hub = getCentralSyncUrl();
  if (!hub) {
    return {
      pushed: 0,
      failed: 0,
      rejected: 0,
      hubDead: 0,
      hubDeadOps: [],
      deviceGate: false,
      deviceTrust: null,
      skipped: true,
      reason: "CENTRAL_SYNC_URL غير مضبوط",
    };
  }

  let hubAuth = await resolveHubAuthHeader(authHeader);
  if (!hubAuth) {
    return {
      pushed: 0,
      failed: 0,
      rejected: 0,
      hubDead: 0,
      hubDeadOps: [],
      deviceGate: false,
      deviceTrust: null,
      skipped: true,
      reason: "لا توجد جلسة مصادقة للمركز",
    };
  }

  // Includes units abandoned in `pushing` by a previous crashed run, once their
  // lease expires — otherwise they would never be retried and never counted.
  const pending = await outbox.listClaimable(ctx.tenantId, 50);
  if (pending.length === 0) {
    return {
      pushed: 0,
      failed: 0,
      rejected: 0,
      hubDead: 0,
      hubDeadOps: [],
      deviceGate: false,
      deviceTrust: null,
      skipped: false,
    };
  }

  await outbox.markPushing(
    pending.map((p) => p.id),
    ctx.tenantId,
  );

  let pushed = 0;
  let failed = 0;
  let rejected = 0;
  let hubDead = 0;
  let deviceGate = false;
  let deviceTrust: SyncDeviceTrustFailure = null;
  const hubDeadOps: string[] = [];
  // SYNC-16: bounded parallel push lanes. Units for the SAME document always
  // share a lane and keep their recorded order (create → update → cancel can
  // never overtake each other), while independent documents drain
  // concurrently — a unit stuck on hub retries no longer head-of-line-blocks
  // the whole batch. Cross-document order was never a business invariant
  // (dependencies converge hub-side via ensureDeps deferral).
  //
  // Lane 0 is the ORDERED lane: entity types whose hub replay is NOT
  // self-sufficient keep global recorded order here. Master rows reference
  // each other (roll → color → fabric) but their snapshots carry no parents,
  // so a roll arriving before its color fails FK and stalls the pull cursor
  // behind it (reproduced live: B's sale 422d on a missing color). Ledger and
  // settlement legs reference parties without carrying snapshots; cashbox
  // close computes from same-date movements; orders may reference masters.
  // Invoice/return/voucher/expense payloads carry full dependency snapshots
  // (ensureDeps upserts parents), so they are arrival-order-independent and
  // spread across the hashed lanes.
  const PUSH_LANES = 4;
  const ORDERED_LANE_TYPES = new Set([
    "party",
    "fabric",
    "color",
    "roll",
    "order",
    "ledger",
    "settlement",
    "cashbox",
    "settings",
    "company",
  ]);
  const laneOf = (entityType: string, entityId: string): number => {
    if (ORDERED_LANE_TYPES.has(entityType)) return 0;
    const key = `${entityType}:${entityId}`;
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return 1 + (Math.abs(h) % (PUSH_LANES - 1));
  };
  const pushOne = async (
    unit: (typeof pending)[number],
  ): Promise<{
    pushed: number;
    failed: number;
    rejected: number;
    hubDead: number;
    hubDeadOps: string[];
    deviceGate: boolean;
    deviceTrust: SyncDeviceTrustFailure;
  }> => {
    const delta = {
      pushed: 0,
      failed: 0,
      rejected: 0,
      hubDead: 0,
      hubDeadOps: [] as string[],
      deviceGate: false,
      deviceTrust: null as SyncDeviceTrustFailure,
    };
    try {
      const postUnit = async (authorization: string) =>
        fetch(`${hub}/api/sync/push`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
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
      if (!hubAuth) return delta;
      let res = await postUnit(hubAuth);
      if (res.status === 401 && (await refreshHubSession())) {
        const refreshed = await resolveHubAuthHeader(authHeader);
        if (refreshed) {
          hubAuth = refreshed;
          res = await postUnit(hubAuth);
        }
      }
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

        if (res.status === 403 && parsed.code && DEVICE_TRUST_CODES.has(parsed.code)) {
          // Device gate: the hub refused the DEVICE (unknown id, revoked,
          // not bound to this user). The CONTENT was never judged, so the
          // pusher must NOT mark the unit rejected — that would roll back a
          // perfectly valid local document. The unit stays pending (the offline
          // story keeps every unsynced document alive) and the run reports the
          // reason so the UI can ask the operator to act instead of spinning
          // silently. Retrying cannot help until the device is
          // registered/reinstated.
          await outbox.resetToPending(unit.id, ctx.tenantId, detail);
          delta.failed += 1;
          delta.deviceGate = true;
          delta.deviceTrust = {
            code: parsed.code,
            message: parsed.message ?? "الجهاز غير مصرّح له بالمزامنة",
          };
          return delta;
        }

        if (res.status === 409 || parsed.code === "SYNC_CONFLICT") {
          await outbox.markRejected(unit.id, ctx.tenantId, detail);
          delta.rejected += 1;
          await rollbackRejectedUnitLocally(
            invoiceRepo,
            auditRepo,
            notificationRepo,
            unit,
            ctx,
            detail,
            parsed.conflictOpId ?? null,
            rollbackRepos,
          );
          return delta;
        }

        if (isRetryablePushStatus(res.status)) {
          // Transient: expired token, rate limit, hub restarting, bad gateway.
          // This must NOT be a permanent rejection. Treating every non-409 4xx
          // as terminal meant one 401 mid-batch marked all remaining units
          // rejected forever — and since the terminal path skips the local
          // rollback, the device kept records that could never reach the hub.
          await outbox.resetToPending(unit.id, ctx.tenantId, detail);
        } else {
          // Permanent rejection (not a conflict, not retryable): the hub will
          // never accept this unit, so the local record must be reconciled
          // exactly like a conflict loser — otherwise the device keeps a
          // document the hub refuses, a silent permanent fork.
          await outbox.markRejected(unit.id, ctx.tenantId, detail);
          delta.rejected += 1;
          await rollbackRejectedUnitLocally(
            invoiceRepo,
            auditRepo,
            notificationRepo,
            unit,
            ctx,
            detail,
            parsed.conflictOpId ?? null,
            rollbackRepos,
          );
        }
        delta.failed += 1;
        return delta;
      }
      // P3a-completion: a 2xx means "accepted", NOT "applied". The hub tells
      // us whether it is done (materialized or terminally dead) or still
      // working (received). Marking everything synced unconditionally left
      // accepted-but-unapplied units in `received` forever with nobody
      // retrying them — the device thought they were done.
      let accepted: unknown = null;
      try {
        accepted = await res.json();
      } catch {
        // Non-JSON 2xx (proxies, old hub builds): fall back to synced, the
        // pre-contract behavior. New hubs always send the contract fields.
      }
      const ack = (accepted ?? {}) as {
        materialized?: boolean;
        terminal?: boolean;
        hubStatus?: string;
        hubReason?: string | null;
      };
      if (ack.materialized) {
        await outbox.markSynced(unit.id, ctx.tenantId);
        delta.pushed += 1;
        return delta;
      }
      if (ack.terminal) {
        // Hub parked the unit as dead: no retry can help, so the device
        // stops, counts it visibly, and notifies the acting user — a hub-side
        // dead letter must never pass as a clean sync. Local reconciliation
        // stays manual here (the local record may be valid against an older
        // hub build), guided by the hub's reason.
        await outbox.markRejected(
          unit.id,
          ctx.tenantId,
          `hubDead: ${ack.hubReason ?? ack.hubStatus ?? "dead"}`,
        );
        delta.rejected += 1;
        delta.hubDead += 1;
        delta.hubDeadOps.push(unit.entityId);
        try {
          const docRef =
            typeof unit.payload.invoiceNumber === "string"
              ? unit.payload.invoiceNumber
              : typeof unit.payload.voucherNumber === "string"
                ? unit.payload.voucherNumber
                : typeof unit.payload.returnNumber === "string"
                  ? unit.payload.returnNumber
                  : typeof unit.payload.expenseNumber === "string"
                    ? unit.payload.expenseNumber
                    : typeof unit.payload.orderCode === "string"
                      ? unit.payload.orderCode
                      : unit.entityId;
          await notificationRepo.create(
            {
              userId: ctx.userId,
              title: "أوقف المركز وحدة مزامنة نهائياً",
              detail: `قبل المركز العملية لكنه أوقفها نهائياً (${ack.hubReason ?? ack.hubStatus ?? "dead"}) — المستند: ${docRef} — راجع سجل الوارد على المركز (/sync/inbox).`,
              kind: "sync",
              severity: "warning",
              targetPath: undefined,
            },
            ctx,
          );
        } catch (err) {
          logger.warn({ err }, "hub-dead notification failed");
        }
        return delta;
      }
      await outbox.resetToPending(
        unit.id,
        ctx.tenantId,
        "hub accepted but not yet applied — retrying",
      );
      delta.failed += 1;
      return delta;
    } catch (err) {
      markHubUnreachable();
      logger.warn({ err, opId: unit.opId }, "sync push unit failed");
      await outbox.resetToPending(
        unit.id,
        ctx.tenantId,
        err instanceof Error ? err.message : "push failed",
      );
      delta.failed += 1;
    }
    return delta;
  };

  // Partition the claimed batch: same document → same lane (order kept),
  // independent documents → concurrent lanes. A lane processes its units
  // strictly in recorded order; lanes race each other freely.
  const lanes: Array<typeof pending> = Array.from({ length: PUSH_LANES }, () => []);
  for (const unit of pending) {
    lanes[laneOf(unit.entityType, unit.entityId)]!.push(unit);
  }
  const laneResults = await Promise.all(
    lanes.map(async (laneUnits) => {
      const acc = {
        pushed: 0,
        failed: 0,
        rejected: 0,
        hubDead: 0,
        hubDeadOps: [] as string[],
        deviceGate: false,
        deviceTrust: null as SyncDeviceTrustFailure,
      };
      for (const unit of laneUnits) {
        const d = await pushOne(unit);
        acc.pushed += d.pushed;
        acc.failed += d.failed;
        acc.rejected += d.rejected;
        acc.hubDead += d.hubDead;
        acc.hubDeadOps.push(...d.hubDeadOps);
        acc.deviceGate = acc.deviceGate || d.deviceGate;
        acc.deviceTrust = acc.deviceTrust ?? d.deviceTrust;
      }
      return acc;
    }),
  );
  for (const r of laneResults) {
    pushed += r.pushed;
    failed += r.failed;
    rejected += r.rejected;
    hubDead += r.hubDead;
    hubDeadOps.push(...r.hubDeadOps);
    deviceGate = deviceGate || r.deviceGate;
    deviceTrust = deviceTrust ?? r.deviceTrust;
  }

  // One notification per run (not per unit): the operator must learn that the
  // device lost its authority, and that nothing was lost locally.
  if (deviceTrust) {
    try {
      await notificationRepo.create(
        {
          userId: ctx.userId,
          title: "أوقف المركز مزامنة هذا الجهاز",
          detail:
            `${deviceTrust.message} — لم يُحذف أي مستند محلي؛ الوحدات غير المرسلة ما زالت محفوظة ` +
            `وستُرسل بعد إعادة تفعيل الجهاز.`,
          kind: "sync",
          severity: "critical",
          targetPath: undefined,
        },
        ctx,
      );
    } catch (err) {
      logger.warn({ err }, "device-trust notification failed");
    }
  }

  return {
    pushed,
    failed,
    rejected,
    hubDead,
    hubDeadOps,
    deviceGate,
    deviceTrust,
    skipped: false,
  };
}

/**
 * HTTP statuses that mean "try again later", never "this operation is invalid".
 * Everything else in the 4xx range is a genuine, permanent rejection.
 */
function isRetryablePushStatus(status: number): boolean {
  if (status >= 500) return true;
  return (
    status === 401 || // expired / not-yet-valid access token
    status === 403 || // permission refresh in flight
    status === 408 || // request timeout
    status === 425 || // too early
    status === 429 // rate limited
  );
}

/** Pull applied units from hub and materialize locally. */
export async function runLocalSyncPull(
  database: DB,
  repos: SyncMaterializeRepos,
  ctx: TenantContext,
  authHeader: string | undefined,
  syncDeviceId: string | null,
  /**
   * Local inbox, used to bound retries on the pull path. Without it a single
   * unit that keeps failing retryably holds the cursor at its position forever
   * (the stream is ordered, so we must not skip ahead silently) and every later
   * operation is stranded behind it — reproduced live 2026-09-10.
   */
  inbox?: ISyncInboxRepository,
): Promise<{
  pulled: number;
  applied: number;
  skipped: number;
  failed: number;
  /** 4B: set when the hub refused the DEVICE (revoked / unknown / not bound). */
  deviceTrust?: SyncDeviceTrustFailure;
}> {
  const hub = getCentralSyncUrl();
  const hubAuth = await resolveHubAuthHeader(authHeader);
  if (!hub || !hubAuth) {
    return { pulled: 0, applied: 0, skipped: 0, failed: 0, deviceTrust: null };
  }

  const cursor = await getPullCursor(ctx.tenantId);
  const afterSeq = cursor.lastPullSeq;
  const qs = new URLSearchParams();
  if (afterSeq !== null) qs.set("afterSeq", String(afterSeq));
  if (syncDeviceId) qs.set("excludeSyncDeviceId", syncDeviceId);
  qs.set("limit", "50");

  let res = await fetch(`${hub}/api/sync/pull?${qs.toString()}`, {
    method: "GET",
    headers: { Authorization: hubAuth },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 && (await refreshHubSession())) {
    const refreshed = await resolveHubAuthHeader(authHeader);
    if (refreshed) {
      res = await fetch(`${hub}/api/sync/pull?${qs.toString()}`, {
        method: "GET",
        headers: { Authorization: refreshed },
        signal: AbortSignal.timeout(20_000),
      });
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 4B: a device-trust refusal is not a transient hub error — surface it as
    // structured authority failure (the caller/UI may stop retrying and tell
    // the operator) instead of a generic "hub pull 403" string.
    if (res.status === 403) {
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        if (parsed.code && DEVICE_TRUST_CODES.has(parsed.code)) {
          return {
            pulled: 0,
            applied: 0,
            skipped: 0,
            failed: 0,
            deviceTrust: { code: parsed.code, message: parsed.message ?? "الجهاز غير مصرّح" },
          };
        }
      } catch {
        // non-JSON body — fall through to the generic error
      }
    }
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
      receivedSeq: number;
      receivedAt: string;
      appliedAt: string | null;
    }>;
  };

  let applied = 0;
  let skipped = 0;
  let failed = 0;
  // Cursor bookkeeping is computed AFTER the page is processed (see below).
  const afterSeqCursor = afterSeq;
  const previousPullAt = cursor.lastPullAt;

  // A unit can arrive BEFORE the unit it depends on: push lanes race, so a
  // return's HTTP push may reach the hub before its sale invoice and be
  // assigned a LOWER received_seq (reproduced live by
  // verify-offline-runtime-drill.mjs — device B pulled return@seq3 before
  // invoice@seq4). The old loop STOPPED the stream at the first retryable
  // failure, so the missing dependency (later in the page) was never pulled,
  // the retry budget burned down round by round, and the unit was parked
  // `dead` — a permanently lost operation. Instead: apply everything that CAN
  // apply, give deferred units extra passes (their dependency may apply later
  // in the same page), and hold the cursor before the earliest unit that
  // still could not apply. Held units are re-pulled next run; already-applied
  // units re-materialize as `exists` (idempotent), so the re-pull is cheap.
  type DeferredUnit = { unit: (typeof body.items)[number]; seq: number; receivedAt: Date };
  type Processed = { seq: number; receivedAt: Date; blocked: boolean };
  const deferred: DeferredUnit[] = [];
  const processed: Processed[] = [];

  const materializeOne = async (
    unit: (typeof body.items)[number],
  ): Promise<MaterializeResult> => {
    try {
      return await materializeSyncUnit(
        database,
        repos,
        unit,
        ctx,
        { opId: unit.opId, syncDeviceId: unit.syncDeviceId, hubCanonical: true },
      );
    } catch (err) {
      logger.warn({ err, opId: unit.opId }, "pull unit apply failed");
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "apply threw",
      };
    }
  };

  const markLocalApplied = async (opId: string) => {
    if (!inbox) return;
    try {
      await inbox.markApplied(ctx.tenantId, opId);
    } catch (err) {
      logger.warn({ err, opId }, "local inbox markApplied failed");
    }
  };

  for (const unit of body.items ?? []) {
    const seq = Number(unit.receivedSeq);
    const receivedAt = new Date(unit.receivedAt);

    // Mirror the unit into the LOCAL inbox first. This is what makes bounded
    // retries possible on the pull path: the row carries `apply_attempts` and
    // can be parked as `dead`, so a unit that can never be applied stops
    // blocking the stream instead of freezing the cursor forever.
    let localRow: SyncInboxRow | null = null;
    if (inbox) {
      try {
        const received = await inbox.receive({
          tenantId: ctx.tenantId,
          syncDeviceId: unit.syncDeviceId && isUuid(unit.syncDeviceId) ? unit.syncDeviceId : null,
          opId: unit.opId,
          entityType: unit.entityType,
          entityId: unit.entityId,
          operation: unit.operation,
          payload: unit.payload,
        });
        localRow = received.row;
      } catch (err) {
        logger.warn({ err, opId: unit.opId }, "local inbox mirror failed");
      }
    }

    // Already resolved on a previous run — nothing to do. The cursor is still
    // bounded by any still-deferred unit with a lower seq (prefix rule below).
    if (localRow && (localRow.status === "applied" || localRow.status === "dead")) {
      if (localRow.status === "applied") applied += 1;
      else skipped += 1;
      processed.push({ seq, receivedAt, blocked: false });
      continue;
    }

    const result = await materializeOne(unit);

    if (result.status === "created" || result.status === "exists") {
      applied += 1;
      await markLocalApplied(unit.opId);
      processed.push({ seq, receivedAt, blocked: false });
    } else if (result.status === "invalid") {
      // Permanently unappliable (malformed payload / unsupported operation).
      // Park it as `dead` and move on: keeping the cursor here would strand
      // every later operation behind a unit that can never succeed.
      skipped += 1;
      logger.error(
        { opId: unit.opId, error: result.error },
        "pull unit permanently invalid — parked as dead",
      );
      if (inbox) {
        try {
          await inbox.setMaterializeError(ctx.tenantId, unit.opId, {
            materializeError: result.error ?? "invalid sync payload",
            permanent: true,
            at: new Date().toISOString(),
          });
          await inbox.markDead(ctx.tenantId, unit.opId, result.error ?? "invalid sync payload");
        } catch (err) {
          logger.warn({ err, opId: unit.opId }, "local inbox markDead failed");
        }
      }
      processed.push({ seq, receivedAt, blocked: false });
    } else {
      // Retryable failure — defer, but keep the stream moving: later units in
      // this page may be the very dependency this unit is waiting for.
      deferred.push({ unit, seq, receivedAt });
      processed.push({ seq, receivedAt, blocked: true });
    }
  }

  // Extra passes: a deferred unit's dependency may have applied later in the
  // same page (a return waiting for its invoice one seq behind it).
  for (let pass = 0; pass < 2 && deferred.length > 0; pass += 1) {
    for (const d of [...deferred]) {
      const result = await materializeOne(d.unit);
      if (result.status === "created" || result.status === "exists") {
        deferred.splice(deferred.indexOf(d), 1);
        applied += 1;
        const rec = processed.find((p) => p.blocked && p.seq === d.seq);
        if (rec) rec.blocked = false;
        await markLocalApplied(d.unit.opId);
      }
    }
  }

  // Final accounting for units that still could not apply: burn ONE attempt
  // for this run, park as `dead` once the budget is spent, and treat the
  // survivors as cursor-blocking.
  for (const d of deferred) {
    let attempts = 0;
    if (inbox) {
      try {
        const updated = await inbox.setMaterializeError(ctx.tenantId, d.unit.opId, {
          materializeError: "materialize deferred — dependency not yet applied",
          at: new Date().toISOString(),
        });
        attempts = updated?.applyAttempts ?? 0;
      } catch (err) {
        logger.warn({ err, opId: d.unit.opId }, "local inbox setMaterializeError failed");
      }
    }
    if (inbox && attempts >= MATERIALIZE_MAX_ATTEMPTS) {
      skipped += 1;
      logger.error({ opId: d.unit.opId, attempts }, "pull unit exhausted its attempt budget — parked as dead");
      try {
        await inbox.markDead(
          ctx.tenantId,
          d.unit.opId,
          "تجاوز عدد محاولات التطبيق: وحدة تنتظر تبعية لم تُطبَّق بعد",
        );
        const rec = processed.find((p) => p.blocked && p.seq === d.seq);
        if (rec) rec.blocked = false; // terminal — no longer blocks the cursor
      } catch (err) {
        logger.warn({ err, opId: d.unit.opId }, "local inbox markDead failed");
      }
    } else {
      failed += 1;
      logger.warn(
        { opId: d.unit.opId, attempts },
        "pull materialize deferred — cursor held before this unit",
      );
    }
  }

  // Cursor: the highest sequence whose ENTIRE prefix is applied/dead — never
  // past a unit that is still waiting. Everything after the hold point that
  // already applied this run re-materializes as `exists` on the next pull.
  const stillBlocked = processed.filter((p) => p.blocked).map((p) => p.seq);
  let newSeq: number | null = afterSeqCursor;
  let newAt: Date | null = previousPullAt;
  const blockedSeq = stillBlocked.length > 0 ? Math.min(...stillBlocked) : null;
  for (const p of processed) {
    if (p.blocked || !Number.isFinite(p.seq)) continue;
    if (blockedSeq !== null && p.seq >= blockedSeq) continue; // prefix rule
    if (newSeq === null || p.seq > newSeq) newSeq = p.seq;
    if (!newAt || p.receivedAt > newAt) newAt = p.receivedAt;
  }
  if ((body.items?.length ?? 0) > 0 && newSeq !== null && newSeq !== afterSeqCursor) {
    await setPullCursor(ctx.tenantId, newSeq, newAt);
  }

  return { pulled: body.items?.length ?? 0, applied, skipped, failed, deviceTrust: null };
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
      /**
       * True when the hub will never do more work for this unit: applied, or
       * parked as dead (visible via /sync/inbox). False means "accepted but
       * still retryable" — the device must re-push later instead of marking
       * the unit synced, or the unit sits `received` forever with nobody
       * retrying it (the T2 gate failure).
       */
      terminal: boolean;
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
      return {
        accepted: true,
        created: false,
        materialized: true,
        terminal: true,
        row: existing.row,
      };
    }
    // Retry materialization for previously accepted-but-not-applied units.
    const mat = await tryMaterializeAcceptedUnit(
      inbox,
      repos,
      database,
      existing.row,
      input.hubCtx,
    );
    if (mat) await releaseClaimsAfterApply(claims, input);
    {
      const row = (await inbox.findByOpId(input.tenantId, input.opId)) ?? existing.row;
      return {
        accepted: true,
        created: false,
        materialized: mat,
        terminal: row.status === "applied" || row.status === "dead",
        row,
      };
    }
  }

  const resources = extractConflictResources(input.entityType, input.operation, input.payload);
  // Invoice updates reserve only their NET stock delta (P3a): an update that
  // only edits notes (lines unchanged) must not hold back concurrent sales.
  if (input.entityType === "invoice" && input.operation === "update") {
    await annotateUpdateClaimDeltas(repos.invoiceRepo, resources, input.payload, input.hubCtx);
  }
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
          availableKg: c.availableKg ?? null,
          requestedKg: c.requestedKg ?? null,
          availablePieces: c.availablePieces ?? null,
          requestedPieces: c.requestedPieces ?? null,
          reason: c.reason ?? "held",
        })),
        loserOpId: input.opId,
        loserEntityId: input.entityId,
        loserInvoiceNumber:
          typeof input.payload.invoiceNumber === "string" ? input.payload.invoiceNumber : null,
      };

      // Insufficient-stock has no winner to blame — the roll itself is short.
      // Recording the loser's own op as conflictOpId would corrupt the
      // provenance chain, so it stays null with the figures in the detail.
      const conflictOpId =
        winner?.reason === "insufficient-stock" ? null : (winner?.claimedByOpId ?? null);
      const rejected = await inbox.markRejected(
        input.tenantId,
        input.opId,
        message,
        conflictOpId,
        conflictDetail,
      );

      // Track the update/cancel loser in the conflict ledger (plan §4/§11).
      // The claim detail already names the winner (claim holder); base version
      // comes from the loser's own payload. Resolution is a separate explicit
      // operator step — never an automatic LWW.
      if (input.operation === "update" || input.operation === "cancel") {
        try {
          await recordSyncConflict({
            tenantId: input.tenantId,
            opId: input.opId,
            entityType: input.entityType,
            entityId: input.entityId,
            operation: input.operation === "cancel" ? "cancel" : "update",
            baseVersion:
              typeof input.payload.baseVersion === "number" ? input.payload.baseVersion : null,
            serverVersion: null, // claim conflict: winner is the claim holder (see conflictDetail)
            localIntent: input.payload,
          });
        } catch (err) {
          logger.warn({ err, opId: input.opId }, "recordSyncConflict (claim) failed");
        }
      }

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
        conflictOpId,
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
  if (materialized) await releaseClaimsAfterApply(claims, input);
  {
    const row = (await inbox.findByOpId(input.tenantId, input.opId)) ?? existing.row;
    return {
      accepted: true,
      created: true,
      materialized,
      terminal: row.status === "applied" || row.status === "dead",
      row,
    };
  }
}

export type SyncClaimInventory = {
  total: number;
  byResourceType: Array<{
    resourceType: string;
    count: number;
    oldestClaimedAt: string | null;
  }>;
  claims: Array<{
    resourceType: string;
    resourceId: string;
    quantityKg: number | null;
    quantityPieces: number | null;
    claimedByOpId: string;
    claimedByDeviceId: string | null;
    entityType: string;
    entityId: string;
    claimedAt: string;
    holderStatus: string | null;
  }>;
};

/**
 * Operator inventory of outstanding first-write-wins claims.
 *
 * Each claim is joined with its holder op's hub inbox status so the operator
 * can distinguish a live reservation (`received`/`applied` holder — hands off)
 * from a stranded one (`dead` holder — safe to reap). Statuses come from the
 * hub inbox because claims only ever exist on the hub.
 */
export async function getSyncClaimInventory(
  inbox: ISyncInboxRepository,
  claims: ISyncResourceClaimRepository,
  tenantId: UUID,
  limit = 200,
): Promise<SyncClaimInventory> {
  const rows = await claims.listByTenant(tenantId, limit);
  const byType = new Map<string, { count: number; oldest: Date | null }>();
  const items: SyncClaimInventory["claims"] = [];
  for (const c of rows) {
    const agg = byType.get(c.resourceType) ?? { count: 0, oldest: null };
    agg.count += 1;
    if (!agg.oldest || c.claimedAt < agg.oldest) agg.oldest = c.claimedAt;
    byType.set(c.resourceType, agg);
    let holderStatus: string | null = null;
    try {
      const holder = await inbox.findByOpId(tenantId, c.claimedByOpId);
      holderStatus = holder?.status ?? null;
    } catch (err) {
      logger.warn({ err, opId: c.claimedByOpId }, "claim holder status lookup failed");
    }
    items.push({
      resourceType: c.resourceType,
      resourceId: c.resourceId,
      quantityKg: c.quantityKg,
      quantityPieces: c.quantityPieces,
      claimedByOpId: c.claimedByOpId,
      claimedByDeviceId: c.claimedByDeviceId,
      entityType: c.entityType,
      entityId: c.entityId,
      claimedAt: c.claimedAt.toISOString(),
      holderStatus,
    });
  }
  return {
    total: rows.length,
    byResourceType: [...byType.entries()].map(([resourceType, agg]) => ({
      resourceType,
      count: agg.count,
      oldestClaimedAt: agg.oldest?.toISOString() ?? null,
    })),
    claims: items,
  };
}

export type SyncClaimReapResult = {
  scanned: number;
  released: number;
  releasedOps: string[];
  kept: number;
};

/**
 * Release claims whose holder op reached the terminal `dead` state.
 *
 * Terminal-gating is the entire safety argument: a `dead` unit will never be
 * retried, so its claims can never serve a future apply. Claims held by
 * `received` (still retrying), `applied` (FWW reservation by design until the
 * quantity-aware work of P3), or `rejected` rows are left untouched — the reap
 * reports them as `kept`, never deletes them.
 */
export async function reapTerminalSyncClaims(
  inbox: ISyncInboxRepository,
  claims: ISyncResourceClaimRepository,
  tenantId: UUID,
): Promise<SyncClaimReapResult> {
  const rows = await claims.listByTenant(tenantId, 5000);
  const opIds = [...new Set(rows.map((r) => r.claimedByOpId))];
  const releasedOps: string[] = [];
  let released = 0;
  let kept = 0;
  for (const opId of opIds) {
    let holderStatus: string | null = null;
    try {
      const holder = await inbox.findByOpId(tenantId, opId);
      holderStatus = holder?.status ?? null;
    } catch (err) {
      logger.warn({ err, opId }, "reap holder status lookup failed");
    }
    if (holderStatus === "dead") {
      const n = await claims.releaseByOp(tenantId, opId);
      released += n;
      if (n > 0) releasedOps.push(opId);
      logger.info({ opId, released: n }, "reaped claims of dead sync unit");
    } else {
      kept += rows.filter((r) => r.claimedByOpId === opId).length;
    }
  }
  return { scanned: rows.length, released, releasedOps, kept };
}

/**
 * F-08: a document that is cancelled must give its shared resources back.
 *
 * An invoice create claims `roll:<id>` for every roll it consumes. Nothing ever
 * released those claims, so once an invoice was cancelled the roll stayed
 * reserved forever and every later sale of it from ANY device was rejected as
 * a first-write-wins conflict — permanent, silent degradation.
 *
 * The release targets the DOCUMENT (entityType + entityId), because the cancel
 * unit carries a different `opId` than the create that made the claim.
 * Best-effort: a failure here must not fail the sync unit itself.
 */
async function releaseClaimsAfterApply(
  claims: ISyncResourceClaimRepository,
  input: { tenantId: UUID; entityType: string; entityId: string; operation: string; opId: string },
): Promise<void> {
  try {
    const releasedOp = await claims.releaseByOp(input.tenantId, input.opId);
    if (releasedOp > 0) {
      logger.info(
        { opId: input.opId, released: releasedOp },
        "released resource claims after applied op",
      );
    }
  } catch (err) {
    logger.warn({ err, opId: input.opId }, "releasing claims by op failed");
  }
  const cancelsDocument =
    (input.entityType === "invoice" || input.entityType === "return") &&
    input.operation === "cancel";
  if (!cancelsDocument) return;
  try {
    const released = await claims.releaseByEntity(
      input.tenantId,
      input.entityType,
      input.entityId,
      ["roll", "invoice_update_roll", "return_roll"],
    );
    if (released > 0) {
      logger.info(
        { entityType: input.entityType, entityId: input.entityId, released },
        "released resource claims after document cancel",
      );
    }
  } catch (err) {
    logger.warn(
      { err, entityType: input.entityType, entityId: input.entityId },
      "releasing resource claims failed",
    );
  }
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
    { opId: row.opId, syncDeviceId: row.syncDeviceId },
  );

  if (result.status === "created" || result.status === "exists") {
    await inbox.markApplied(row.tenantId, row.opId);
    // The update/cancel actually converged (a duplicate delivery or a later
    // retry succeeded) — do not leave its conflict record sitting open.
    if (row.operation === "update" || row.operation === "cancel") {
      await resolveSyncConflictByOp(row.tenantId, row.opId, "unit applied");
    }
    return true;
  }

  if (result.status === "invalid") {
    /**
     * Permanent. The previous code marked this `applied`, which silently
     * discarded the operation — the payload was malformed or the operation
     * unsupported, so retrying could never help, but the hub reported success
     * and the peer never received the unit. Park it as `dead` so it is
     * visible and countable instead of vanishing.
     */
    await inbox.setMaterializeError(row.tenantId, row.opId, {
      materializeError: result.error ?? "invalid sync payload",
      permanent: true,
      at: new Date().toISOString(),
    });
    await inbox.markDead(
      row.tenantId,
      row.opId,
      `حمولة غير قابلة للتطبيق نهائياً: ${result.error ?? "unknown"}`,
    );
    logger.error(
      { opId: row.opId, error: result.error },
      "sync unit parked as dead — permanently invalid payload",
    );
    return false;
  }

  const updated = await inbox.setMaterializeError(row.tenantId, row.opId, {
    materializeError: result.error ?? "unknown",
    at: new Date().toISOString(),
  });

  // Bounded retries. Most retryable failures resolve on their own once the
  // unit they depend on is applied (an update waiting for its create). But an
  // unbounded retry loop is invisible: the unit simply never converges and no
  // one is told. After the budget is spent it is parked as `dead` so the
  // operator sees it in /sync/status instead of a silent black hole.
  const attempts = updated?.applyAttempts ?? 0;
  if (attempts >= MATERIALIZE_MAX_ATTEMPTS) {
    await inbox.markDead(
      row.tenantId,
      row.opId,
      `تجاوز عدد محاولات التطبيق (${attempts}): ${result.error ?? "unknown"}`,
    );
    logger.error(
      { opId: row.opId, attempts, error: result.error },
      "sync unit parked as dead after exhausting apply attempts",
    );
    return false;
  }

  logger.warn(
    { opId: row.opId, attempts, error: result.error },
    "hub materialize deferred — unit stays received",
  );
  return false;
}

/**
 * Reconcile a terminally-rejected sync unit with the local database.
 *
 * Two outcomes, never silence:
 * - `rolledBack`: a created document was cancelled locally through its own
 *   cancel use-case, so local state matches what the hub will ever accept.
 * - `flagged`: the unit cannot be auto-reverted safely (an update whose edits
 *   embody user intent, a cancel that already took local effect, a master row
 *   that other documents may reference, or a create whose repository was not
 *   wired). The operator gets a `kind='sync'` notification naming the exact
 *   manual step — the fork stays visible instead of silent.
 *
 * Returns the outcome so the notification text states precisely what happened.
 */
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
  rollbackRepos?: SyncRollbackRepos,
): Promise<{ rolledBack: boolean; resolution: string }> {
  const outcome = await cancelRejectedCreateLocally(
    invoiceRepo,
    auditRepo,
    unit,
    ctx,
    rollbackRepos,
  );

  let resolution: string;
  if (outcome === "rolled-back") {
    resolution = "أُبطل المستند محلياً ليتوافق مع قرار المركز";
  } else if (outcome === "already-resolved") {
    resolution = "المستند محلول محلياً مسبقاً (ملغى) — لا حاجة لإجراء";
  } else if (outcome === "cancel-not-wired") {
    resolution =
      "تعذّر الإبطال التلقائي (المستودع غير مربوط) — يلزم تدخل يدوي: راجع السجل ثم أبطله يدوياً";
  } else if (outcome === "rollback-failed") {
    resolution =
      "تعذّر الإبطال التلقائي (رفضه منطق العمل — قد يكون المستند مسوّى) — يلزم تدخل يدوي: راجع السجل ونسّق مع المركز";
  } else if (unit.operation === "update") {
    resolution =
      "رُفض التعديل مع بقاء التعديل المحلي — أعد إدخال التعديل بعد مراجعة النسخة الفائزة على المركز";
  } else if (unit.operation === "cancel") {
    resolution = "رُفض الإلغاء مع بقاء الإلغاء المحلي — راجع حالة المستند على المركز ونسّق يدوياً";
  } else {
    resolution = "رُفضت العملية نهائياً — راجع السجل من /sync/inbox ونسّق يدوياً";
  }

  try {
    const docRef =
      typeof unit.payload.invoiceNumber === "string"
        ? unit.payload.invoiceNumber
        : typeof unit.payload.voucherNumber === "string"
          ? unit.payload.voucherNumber
          : typeof unit.payload.returnNumber === "string"
            ? unit.payload.returnNumber
            : typeof unit.payload.expenseNumber === "string"
              ? unit.payload.expenseNumber
              : typeof unit.payload.orderCode === "string"
                ? unit.payload.orderCode
                : unit.entityId;
    const targetPath =
      unit.entityType === "invoice"
        ? `/invoices/${unit.entityId}`
        : unit.entityType === "voucher"
          ? `/vouchers/${unit.entityId}`
          : unit.entityType === "return"
            ? `/returns/${unit.entityId}`
            : unit.entityType === "order"
              ? `/orders/${unit.entityId}`
              : unit.entityType === "expense"
                ? `/expenses/${unit.entityId}`
                : unit.entityType === "settlement"
                  ? `/customers/${unit.entityId}`
                  : unit.entityType === "cashbox"
                    ? `/cashbox`
                    : undefined;
    await notificationRepo.create(
      {
        userId: ctx.userId,
        title: "أُبطلت عملية محلية بعد رفض المزامنة",
        detail: `${detail}${conflictOpId ? ` (فازت العملية ${conflictOpId})` : ""} — المستند: ${docRef} — ${resolution}`,
        kind: "sync",
        severity: "warning",
        targetPath,
      },
      ctx,
    );
  } catch (err) {
    logger.warn({ err }, "local conflict notification failed");
  }

  return { rolledBack: outcome === "rolled-back", resolution };
}

/**
 * Cancel a locally-created document whose sync unit was terminally rejected.
 *
 * Only `create` operations are auto-reverted: the document exists locally with
 * the exact id the hub refused, and its cancel use-case is the domain's own
 * reversal (stock/ledger/cash legs included). Anything else returns a
 * non-rollback outcome so the caller flags instead of destroying intent.
 */
async function cancelRejectedCreateLocally(
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  unit: {
    entityType: string;
    entityId: string;
    operation: string;
    payload?: Record<string, unknown>;
  },
  ctx: TenantContext,
  rollbackRepos?: SyncRollbackRepos,
): Promise<
  "rolled-back" | "already-resolved" | "cancel-not-wired" | "rollback-failed" | "not-a-create"
> {
  if (unit.operation !== "create") return "not-a-create";
  try {
    switch (unit.entityType) {
      case "invoice": {
        const existing = await invoiceRepo.findById(unit.entityId, ctx);
        if (existing && existing.status === "cancelled") return "already-resolved";
        // P0-001: expectedVersion is REQUIRED - fetch current version for optimistic concurrency
        const expectedVersion = existing ? existing.version : 1;
        const r = await cancelInvoiceUseCase(
          invoiceRepo,
          auditRepo,
          unit.entityId,
          ctx.userId,
          ctx,
          expectedVersion,
        );
        // Cancel use-cases return Result instead of throwing: a business
        // refusal (settled document, day locked) must surface as a failed
        // rollback, never as a silent success.
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      case "voucher": {
        if (!rollbackRepos?.voucherRepo) return "cancel-not-wired";
        // P0-001: expectedVersion is REQUIRED - fetch current version
        const currentVoucher = await rollbackRepos.voucherRepo.findById(unit.entityId, ctx);
        const expectedVersionVoucher = currentVoucher ? currentVoucher.version : 1;
        const r = await cancelVoucherUseCase(
          rollbackRepos.voucherRepo,
          auditRepo,
          unit.entityId,
          ctx.userId,
          ctx,
          expectedVersionVoucher,
        );
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      case "return": {
        if (!rollbackRepos?.returnRepo) return "cancel-not-wired";
        // P0-001: expectedVersion is REQUIRED - fetch current version
        const currentReturn = await rollbackRepos.returnRepo.findById(unit.entityId, ctx);
        const expectedVersionReturn = currentReturn ? currentReturn.version : 1;
        const r = await cancelReturnUseCase(
          rollbackRepos.returnRepo,
          auditRepo,
          unit.entityId,
          ctx.userId,
          ctx,
          expectedVersionReturn,
        );
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      case "order": {
        if (!rollbackRepos?.orderRepo) return "cancel-not-wired";
        // P0-001: expectedVersion is REQUIRED - fetch current version
        const currentOrder = await rollbackRepos.orderRepo.findById(unit.entityId, ctx);
        const expectedVersionOrder = currentOrder ? currentOrder.version : 1;
        const r = await cancelOrderUseCase(rollbackRepos.orderRepo, unit.entityId, ctx, expectedVersionOrder);
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      case "expense": {
        if (!rollbackRepos?.expenseRepo) return "cancel-not-wired";
        // P0-001: expectedVersion is REQUIRED - fetch current version
        const currentExpense = await rollbackRepos.expenseRepo.findById(unit.entityId, ctx);
        const expectedVersionExpense = currentExpense ? currentExpense.version : 1;
        const r = await cancelExpenseUseCase(
          rollbackRepos.expenseRepo,
          auditRepo,
          unit.entityId,
          ctx.userId,
          ctx,
          expectedVersionExpense,
        );
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      case "settlement": {
        // A losing settlement is reversed by reference — the same reversal
        // the domain uses for settlement rows. Without the captured
        // reference the local rows cannot be addressed: flag instead.
        if (!rollbackRepos?.ledgerRepo) return "cancel-not-wired";
        const ref = unit.payload?.settlementRef as
          { referenceType?: string; referenceId?: string } | undefined;
        if (typeof ref?.referenceType !== "string" || typeof ref?.referenceId !== "string") {
          return "cancel-not-wired";
        }
        const r = await cancelLedgerByReferenceUseCase(
          rollbackRepos.ledgerRepo,
          ref.referenceType,
          ref.referenceId,
          ctx.userId,
          ctx,
        );
        if (!r.ok) {
          logger.warn({ entityId: unit.entityId, error: r.error }, "local rollback cancel refused");
          return "rollback-failed";
        }
        return "rolled-back";
      }
      default:
        // Master rows (party/fabric/color/roll) are never auto-deleted: other
        // documents may already reference them, and deletion would destroy the
        // audit trail. Cashbox opening/close units (operations "opening" /
        // "close", not "create") likewise keep their local effect — closes are
        // never auto-undone. All resolve to a flagged notification instead.
        return "not-a-create";
    }
  } catch (err) {
    // A failed cancel (e.g. document already settled) must not fail the sync
    // run and must not pretend success: the flagged notification below carries
    // the manual-resolution guidance, so the fork stays visible.
    logger.warn({ err, entityId: unit.entityId }, "local rollback cancel failed");
    return "cancel-not-wired";
  }
}

type RollDemand = { quantityKg: number | null; quantityPieces: number | null };

function sumDemandByRoll(lines: unknown): Map<string, RollDemand> | null {
  // Sums line demand per roll in BOTH constrained dimensions. The use-case
  // guards kilograms AND pieces on every sale, so a claim that measures only
  // one would admit phantom fits (the T2 gate failure: kg fit, pieces gone).
  // Piece default mirrors the domain (`l.pieces ?? 1` in the use-case and
  // repository). Returns NULL (not empty) when lines are absent/non-array —
  // NULL means "unmeasurable" and the caller falls back to a whole-resource
  // claim (pre-P3a behavior), never to zero. Per-dimension poisoning: garbage
  // kg nulls only kg, garbage pieces nulls only pieces.
  if (!Array.isArray(lines)) return null;
  const sums = new Map<string, RollDemand>();
  for (const line of lines) {
    if (typeof line !== "object" || line === null) return null;
    const { rollId, quantityKg, pieces } = line as {
      rollId?: unknown;
      quantityKg?: unknown;
      pieces?: unknown;
    };
    if (typeof rollId !== "string" || !isUuid(rollId)) continue;
    const q = Number(quantityKg);
    const p = Number(pieces ?? 1);
    const prev = sums.get(rollId) ?? { quantityKg: 0, quantityPieces: 0 };
    sums.set(rollId, {
      quantityKg:
        !Number.isFinite(q) || q < 0 || prev.quantityKg === null ? null : prev.quantityKg + q,
      quantityPieces:
        !Number.isFinite(p) || p < 0 || prev.quantityPieces === null
          ? null
          : prev.quantityPieces + p,
    });
  }
  return sums;
}

/**
 * Narrow invoice-update reservations to net stock deltas.
 *
 * `extractConflictResources` can only see the update's NEW lines, so it
 * conservatively reserves their full sum. When the hub already holds the
 * invoice, the true contention is new-minus-old per roll: an update that only
 * touches notes reserves zero and never blocks a sale; a quantity increase
 * reserves exactly the increase. A freed roll (delta negative) reserves
 * nothing — freed stock needs no reservation.
 *
 * Fail-open conservative: a missing/unreadable hub invoice keeps the full
 * new-lines reservation (the update will fail retryably in materialization
 * anyway until its create arrives).
 */
async function annotateUpdateClaimDeltas(
  invoiceRepo: IInvoiceRepository,
  resources: Array<{
    resourceType: string;
    resourceId: string;
    quantityKg?: number | null;
    quantityPieces?: number | null;
  }>,
  payload: Record<string, unknown>,
  hubCtx: TenantContext,
): Promise<void> {
  const targets = resources.filter(
    (r) => r.resourceType === "roll" && (r.quantityKg != null || r.quantityPieces != null),
  );
  if (targets.length === 0) return;
  const invoiceId =
    typeof payload.invoiceId === "string" && isUuid(payload.invoiceId) ? payload.invoiceId : null;
  if (!invoiceId) return;
  let oldDemand: Map<string, RollDemand> | null = null;
  try {
    const existing = await invoiceRepo.findById(invoiceId, hubCtx);
    oldDemand = sumDemandByRoll((existing as unknown as { lines?: unknown } | null)?.lines ?? null);
  } catch (err) {
    logger.warn({ err, invoiceId }, "update claim delta lookup failed — keeping full reservation");
    return;
  }
  if (!oldDemand) return;
  const newDemand = sumDemandByRoll(
    (payload.updateInput as { lines?: unknown } | undefined)?.lines ?? null,
  );
  if (!newDemand) return;
  for (const r of targets) {
    const old = oldDemand.get(r.resourceId) ?? { quantityKg: 0, quantityPieces: 0 };
    const cur = newDemand.get(r.resourceId) ?? { quantityKg: 0, quantityPieces: 0 };
    if (r.quantityKg != null) {
      r.quantityKg = Math.max(0, (cur.quantityKg ?? 0) - (old.quantityKg ?? 0));
    }
    if (r.quantityPieces != null) {
      r.quantityPieces = Math.max(0, (cur.quantityPieces ?? 0) - (old.quantityPieces ?? 0));
    }
  }
}

function extractConflictResources(
  entityType: string,
  operation: string,
  payload: Record<string, unknown>,
): Array<{
  resourceType: string;
  resourceId: string;
  quantityKg?: number | null;
  quantityPieces?: number | null;
}> {
  if (entityType === "invoice" && (operation === "create" || operation === "update")) {
    const rollIds = Array.isArray(payload.rollIds)
      ? payload.rollIds.filter((id): id is string => typeof id === "string" && isUuid(id))
      : [];
    // Line demand makes the claim measurable (P3a); dimensions the lines do
    // not quantify stay NULL and keep whole-resource semantics for that row.
    const rawLines =
      operation === "create"
        ? ((payload.lines ??
            (payload.createInput as { lines?: unknown } | undefined)?.lines) as unknown)
        : ((payload.updateInput as { lines?: unknown } | undefined)?.lines as unknown);
    const demand = sumDemandByRoll(rawLines);
    if (rollIds.length > 0) {
      // NOTE (P3a): updates reserve from the SAME `roll` pool as creates.
      // A separate namespace would blind updates and sales to each other and
      // allow joint oversell. Net-delta narrowing happens in
      // annotateUpdateClaimDeltas; applied creates never self-conflict because
      // applied holders are excluded from outstanding.
      return rollIds.map((resourceId) => ({
        resourceType: "roll",
        resourceId,
        quantityKg: demand?.get(resourceId)?.quantityKg ?? null,
        quantityPieces: demand?.get(resourceId)?.quantityPieces ?? null,
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
  if (entityType === "voucher" && operation === "cancel") {
    if (typeof payload.voucherId === "string" && isUuid(payload.voucherId)) {
      return [{ resourceType: "voucher_cancel", resourceId: payload.voucherId }];
    }
  }
  if (entityType === "return" && operation === "create") {
    const rollIds = Array.isArray(payload.rollIds)
      ? payload.rollIds.filter((id): id is string => typeof id === "string" && isUuid(id))
      : [];
    // Returns add stock, but a not-yet-applied return must not conjure
    // phantom availability for concurrent sales (it may still fail) — so the
    // return reserves its demand conservatively, like a sale.
    const demand = sumDemandByRoll(
      (payload.createInput as { lines?: unknown } | undefined)?.lines as unknown,
    );
    if (rollIds.length > 0) {
      return rollIds.map((resourceId) => ({
        resourceType: "return_roll",
        resourceId,
        quantityKg: demand?.get(resourceId)?.quantityKg ?? null,
        quantityPieces: demand?.get(resourceId)?.quantityPieces ?? null,
      }));
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
  // F-08: Master data creation (party, fabric, color, roll) does NOT claim
  // resources. Resource claims exist to prevent concurrent mutations of shared
  // resources (e.g. two invoices selling the same roll). Master data creation
  // is an idempotent entity-lifecycle operation, not a stock mutation — it
  // should never conflict with transactions that reference the entity.
  // Dependency ordering is handled by the existing dependency snapshot system
  // (see ensureDeps / ensureInvoiceSyncDependencies), not by resource claims.
  //
  // SYNC-13: master UPDATE/DELETE and order UPDATE DO claim — identity claims
  // (one winner per entity). Two devices editing the same master concurrently
  // serialize: the loser 409s and rebases via the notify+flag path, exactly
  // like invoice-update losers. New namespaces below follow the same rule:
  // concurrent mutations of the SAME shared object serialize; independent
  // appends (ledger entries, manual movements) claim nothing and converge by id.
  if (
    (entityType === "party" ||
      entityType === "fabric" ||
      entityType === "color" ||
      entityType === "roll") &&
    (operation === "update" || operation === "delete")
  ) {
    if (typeof payload.entityId === "string" && isUuid(payload.entityId)) {
      return [{ resourceType: entityType, resourceId: payload.entityId }];
    }
    return [];
  }
  if (entityType === "order" && operation === "update") {
    if (typeof payload.orderId === "string" && isUuid(payload.orderId)) {
      return [{ resourceType: "order_update", resourceId: payload.orderId }];
    }
    return [];
  }
  if (entityType === "ledger" && operation === "cancel") {
    if (
      typeof payload.referenceType === "string" &&
      typeof payload.referenceId === "string" &&
      isUuid(payload.referenceId)
    ) {
      // Ledger entries are immutable rows: cancel-by-reference is a
      // single-winner operation per referenced document.
      return [
        {
          resourceType: "ledger_cancel",
          resourceId: uuidFromString(
            `ledger-cancel:${payload.referenceType}:${payload.referenceId}`,
          ),
        },
      ];
    }
    return [];
  }
  if (entityType === "settlement" && operation === "create") {
    if (typeof payload.partyId === "string" && isUuid(payload.partyId)) {
      // Two devices settling the same party concurrently MUST serialize: the
      // repo computes the amount from live balance, so a blind replay of the
      // loser would settle an already-settled balance a second time.
      return [{ resourceType: "settlement", resourceId: payload.partyId }];
    }
    return [];
  }
  if (entityType === "cashbox" && operation === "opening") {
    // One opening balance per tenant. Claims are tenant-scoped, so a stable
    // derived UUID is unique where it matters.
    return [{ resourceType: "cashbox_opening", resourceId: uuidFromString("cashbox:opening") }];
  }
  if (entityType === "cashbox" && operation === "movement-cancel") {
    if (typeof payload.movementId === "string" && isUuid(payload.movementId)) {
      return [{ resourceType: "cashbox_movement", resourceId: payload.movementId }];
    }
    return [];
  }
  if (entityType === "cashbox" && operation === "close") {
    if (typeof payload.closeDate === "string" && payload.closeDate.length >= 8) {
      // One winner per business date: two devices closing the same day
      // serialize, the loser 409s with the winner named.
      return [
        {
          resourceType: "cashbox_close",
          resourceId: uuidFromString(`cashbox-close:${payload.closeDate}`),
        },
      ];
    }
    return [];
  }
  // No claims: ledger creates (id-keyed appends), cashbox movements
  // (id-keyed appends), settings/company snapshots (hub-wins, versioned).
  return [];
}

/**
 * Stable UUID for synthetic claim keys (dates, tenant-wide singletons).
 * Same input on any device yields the same UUID, so concurrent units contend
 * on the same claim row. Claims are tenant-scoped — the tenant column, not
 * this UUID, separates tenants.
 */
function uuidFromString(value: string): string {
  const h = createHash("sha256").update(value, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
        availableKg?: number | null;
        requestedKg?: number | null;
        availablePieces?: number | null;
        requestedPieces?: number | null;
        reason?: "held" | "insufficient-stock";
      }
    | undefined,
): string {
  const loserNumber =
    typeof payload.invoiceNumber === "string" ? payload.invoiceNumber : "مستند محلي";
  if (!winner) {
    return `رُفضت مزامنة «${loserNumber}» لأن جهازاً آخر سبق بمزامنة نفس الموارد`;
  }
  if (winner.reason === "insufficient-stock") {
    // No winner: the roll itself is short. Figures name the exact shortage so
    // the operator resizes the sale instead of retrying blindly.
    const kg =
      winner.availableKg != null && winner.requestedKg != null
        ? ` (المتاح ${winner.availableKg} كغ، المطلوب ${winner.requestedKg} كغ)`
        : "";
    const pc =
      winner.availablePieces != null && winner.requestedPieces != null
        ? ` (المتاح ${winner.availablePieces} أثواب، المطلوب ${winner.requestedPieces} أثواب)`
        : "";
    return `رُفضت مزامنة «${loserNumber}»: مخزون اللفافة لا يكفي${kg}${pc}`;
  }
  const qty =
    winner.availableKg != null && winner.requestedKg != null
      ? ` (المتاح ${winner.availableKg} كغ، المطلوب ${winner.requestedKg} كغ)`
      : "";
  return (
    `رُفضت مزامنة «${loserNumber}» بالكامل (أول واصل يفوز). ` +
    `سبقها ${winner.entityType} ${winner.entityId} على المورد ${winner.resourceType}:${winner.resourceId} ` +
    `في ${winner.claimedAt.toISOString()}${qty}`
  );
}

async function getPullCursor(
  tenantId: string,
): Promise<{ lastPullSeq: number | null; lastPullAt: Date | null }> {
  return runWithTenantContext({ tenantId }, async () => {
    const [row] = await db
      .select()
      .from(syncState)
      .where(eq(syncState.tenantId, tenantId))
      .limit(1);
    return {
      lastPullSeq: row?.lastPullSeq ?? null,
      lastPullAt: row?.lastPullAt ?? null,
    };
  });
}

async function setPullCursor(tenantId: string, seq: number, at: Date | null): Promise<void> {
  await runWithTenantContext({ tenantId }, async () => {
    await db
      .insert(syncState)
      .values({ tenantId, lastPullSeq: seq, lastPullAt: at, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [syncState.tenantId],
        set: { lastPullSeq: seq, lastPullAt: at, updatedAt: new Date() },
      });
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
