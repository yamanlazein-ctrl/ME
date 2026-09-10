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
  listPending(tenantId: UUID, limit?: number): Promise<SyncOutboxRow[]>;
  markPushing(ids: UUID[], tenantId: UUID): Promise<void>;
  markSynced(id: UUID, tenantId: UUID): Promise<void>;
  markRejected(id: UUID, tenantId: UUID, errorDetail: string): Promise<void>;
  /** Soft failure — keep unit eligible for the next sync run. */
  resetToPending(id: UUID, tenantId: UUID, errorDetail?: string): Promise<void>;
  countPending(tenantId: UUID): Promise<number>;
}
