import type { UUID } from "../../domain/types/index.js";

export type SyncOutboxStatus = "pending" | "pushing" | "synced" | "rejected";

export interface SyncOutboxRow {
  id: UUID;
  tenantId: UUID;
  syncDeviceId: UUID | null;
  opId: UUID;
  entityType: string;
  entityId: UUID;
  operation: string;
  payload: Record<string, unknown>;
  status: SyncOutboxStatus;
  errorDetail: string | null;
  /** Monotonic insertion order — the only stable ordering key. */
  seq: number;
  createdAt: Date;
  updatedAt: Date;
  syncedAt: Date | null;
  /** REPAIR-027: present after claimBatch; required to finalize. */
  leaseToken?: UUID | null;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
}

export interface EnqueueSyncOutboxInput {
  tenantId: UUID;
  syncDeviceId?: UUID | null;
  opId: UUID;
  entityType: string;
  entityId: UUID;
  operation: string;
  payload: Record<string, unknown>;
}

export interface ISyncOutboxRepository {
  enqueue(input: EnqueueSyncOutboxInput): Promise<SyncOutboxRow>;
  /**
   * Units eligible for the next push, in the exact order they were recorded.
   *
   * Includes `pending` rows AND `pushing` rows whose lease has expired. The
   * second half is what makes a mid-push crash recoverable: `markPushing`
   * happens before the network loop, so a process that dies in between would
   * otherwise strand those units in `pushing` forever — invisible to both the
   * retry loop and the UI counter.
   */
  listClaimable(
    tenantId: UUID,
    limit?: number,
    stalePushingMs?: number,
  ): Promise<SyncOutboxRow[]>;
  /** @deprecated Prefer claimBatch (REPAIR-007). */
  markPushing(ids: UUID[], tenantId: UUID): Promise<void>;
  /**
   * Atomic claim (REPAIR-007 + REPAIR-027): SELECT … FOR UPDATE SKIP LOCKED
   * then stamp lease_owner / lease_token / lease_until in one statement.
   */
  claimBatch(
    tenantId: UUID,
    limit: number,
    leaseMs: number,
    owner: string,
  ): Promise<SyncOutboxRow[]>;
  markSynced(id: UUID, tenantId: UUID, leaseToken: UUID): Promise<number>;
  markRejected(
    id: UUID,
    tenantId: UUID,
    errorDetail: string,
    leaseToken: UUID,
  ): Promise<number>;
  /** Soft failure — keep unit eligible for the next sync run. */
  resetToPending(
    id: UUID,
    tenantId: UUID,
    errorDetail: string | undefined,
    leaseToken: UUID,
  ): Promise<number>;
  /** pending + pushing — everything not yet settled. Drives the UI counter. */
  countOutstanding(tenantId: UUID): Promise<number>;
  /** Per-status counts so stuck work is observable instead of invisible. */
  countByStatus(tenantId: UUID): Promise<Record<SyncOutboxStatus, number>>;
}
