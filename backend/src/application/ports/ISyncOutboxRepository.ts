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
  markPushing(ids: UUID[], tenantId: UUID): Promise<void>;
  markSynced(id: UUID, tenantId: UUID): Promise<void>;
  markRejected(id: UUID, tenantId: UUID, errorDetail: string): Promise<void>;
  /** Soft failure — keep unit eligible for the next sync run. */
  resetToPending(id: UUID, tenantId: UUID, errorDetail?: string): Promise<void>;
  /** pending + pushing — everything not yet settled. Drives the UI counter. */
  countOutstanding(tenantId: UUID): Promise<number>;
  /** Per-status counts so stuck work is observable instead of invisible. */
  countByStatus(tenantId: UUID): Promise<Record<SyncOutboxStatus, number>>;
}
