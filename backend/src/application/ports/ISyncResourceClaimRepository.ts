import type { UUID } from "../../domain/types/index.js";

export interface SyncResourceClaimRow {
  id: UUID;
  tenantId: UUID;
  resourceType: string;
  resourceId: UUID;
  claimedByOpId: UUID;
  claimedByDeviceId: UUID | null;
  entityType: string;
  entityId: UUID;
  claimedAt: Date;
}

export interface TryClaimResourcesInput {
  tenantId: UUID;
  opId: UUID;
  syncDeviceId?: UUID | null;
  entityType: string;
  entityId: UUID;
  resources: Array<{ resourceType: string; resourceId: UUID }>;
}

export type TryClaimResourcesResult =
  | { ok: true; claims: SyncResourceClaimRow[] }
  | {
      ok: false;
      conflicts: Array<{
        resourceType: string;
        resourceId: UUID;
        claimedByOpId: UUID;
        claimedByDeviceId: UUID | null;
        entityType: string;
        entityId: UUID;
        claimedAt: Date;
      }>;
    };

export interface ISyncResourceClaimRepository {
  tryClaimAll(input: TryClaimResourcesInput): Promise<TryClaimResourcesResult>;
  listByOp(tenantId: UUID, opId: UUID): Promise<SyncResourceClaimRow[]>;
}
