import type { UUID } from "../../domain/types/index.js";

export type SyncInboxStatus = "received" | "applied" | "rejected" | "dead";

export interface SyncInboxRow {
  id: UUID;
  tenantId: UUID;
  syncDeviceId: UUID | null;
  opId: UUID;
  entityType: string;
  entityId: UUID;
  operation: string;
  payload: Record<string, unknown>;
  status: SyncInboxStatus;
  rejectReason: string | null;
  conflictOpId: UUID | null;
  conflictDetail: Record<string, unknown> | null;
  materializeError: Record<string, unknown> | null;
  applyAttempts: number;
  lastAttemptAt: Date | null;
  /** Monotonic receive order — the only valid pull cursor. */
  receivedSeq: number;
  receivedAt: Date;
  appliedAt: Date | null;
}

export interface ReceiveSyncUnitInput {
  tenantId: UUID;
  syncDeviceId?: UUID | null;
  opId: UUID;
  entityType: string;
  entityId: UUID;
  operation: string;
  payload: Record<string, unknown>;
  status?: SyncInboxStatus;
  rejectReason?: string | null;
  conflictOpId?: UUID | null;
  conflictDetail?: Record<string, unknown> | null;
}

export interface ISyncInboxRepository {
  /** Idempotent receive — returns existing row if opId already present. */
  receive(input: ReceiveSyncUnitInput): Promise<{ row: SyncInboxRow; created: boolean }>;
  markRejected(
    tenantId: UUID,
    opId: UUID,
    reason: string,
    conflictOpId?: UUID | null,
    conflictDetail?: Record<string, unknown> | null,
  ): Promise<SyncInboxRow | null>;
  markApplied(tenantId: UUID, opId: UUID): Promise<SyncInboxRow | null>;
  findByOpId(tenantId: UUID, opId: UUID): Promise<SyncInboxRow | null>;
  /**
   * Hub → peer pull: applied units after a monotonic cursor.
   *
   * `afterSeq` is `sync_inbox.received_seq`, NOT a timestamp. A timestamp
   * cursor loses operations: `received_at` is transaction-start time, so rows
   * sharing it are skipped by a strict `>`; and a unit that was received before
   * the cursor but only applied later would never be returned at all.
   *
   * `excludeSyncDeviceId` is applied IN SQL so that the LIMIT counts rows the
   * caller will actually receive — post-filtering after the LIMIT let a busy
   * device fill the whole window with its own units and stall the pull forever.
   */
  listAppliedSince(
    tenantId: UUID,
    afterSeq: number | null,
    opts?: { excludeSyncDeviceId?: UUID | null; limit?: number },
  ): Promise<SyncInboxRow[]>;
  /** Record a failed materialization attempt; returns the updated row. */
  setMaterializeError(
    tenantId: UUID,
    opId: UUID,
    detail: Record<string, unknown>,
  ): Promise<SyncInboxRow | null>;
  /** Park a unit that exhausted its attempts so it is visible, not silent. */
  markDead(tenantId: UUID, opId: UUID, reason: string): Promise<SyncInboxRow | null>;
  countByStatus(tenantId: UUID): Promise<Record<SyncInboxStatus, number>>;
  /**
   * Operational visibility: list units by status so an operator can see what
   * is stuck. A unit that never materialized used to be invisible — it was
   * neither `applied` (so peers never pulled it) nor surfaced anywhere.
   */
  listByStatus(
    tenantId: UUID,
    statuses: SyncInboxStatus[],
    limit?: number,
  ): Promise<SyncInboxRow[]>;
}
