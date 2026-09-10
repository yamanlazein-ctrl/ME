import type { UUID } from "../../domain/types/index.js";

export type SyncInboxStatus = "received" | "applied" | "rejected";

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
  /** Hub → peer pull: applied units after a cursor, optionally excluding one device. */
  listAppliedSince(
    tenantId: UUID,
    after: Date | null,
    opts?: { excludeSyncDeviceId?: UUID | null; limit?: number },
  ): Promise<SyncInboxRow[]>;
  setMaterializeError(
    tenantId: UUID,
    opId: UUID,
    detail: Record<string, unknown>,
  ): Promise<SyncInboxRow | null>;
}
