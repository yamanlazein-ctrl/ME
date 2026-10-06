/** Persistence behind per-device document-number blocks (numberBlockUseCases), per engine (S1). */
import type { UUID } from "../../domain/types/index.js";

export interface ClaimedNumberBlock {
  id: string;
  entityType: string;
  year: number;
  prefix: string;
  startNumber: number;
  endNumber: number;
  nextNumber: number;
}

export interface INumberBlockStore {
  /** Raise the sequence tip to knownUsed (bounded), then carve a block — one transaction. */
  claimBlock(input: {
    tenantId: UUID;
    syncDeviceId: UUID;
    entityType: string;
    size?: number;
    year: number;
    knownUsed?: number | null;
  }): Promise<ClaimedNumberBlock>;
  reclaimBlockTail(input: { tenantId: UUID; blockId: UUID }): Promise<{ reclaimed: number; newGlobalLast: number | null }>;
  /** Numbers still unused across this device's active blocks for the entity/year. */
  remainingInActiveBlocks(tenantId: UUID, syncDeviceId: UUID, entityType: string, year: number): Promise<number>;
  readSequenceTip(tenantId: UUID, entityType: string, prefix: string): Promise<number>;
  /** Monotonic: lastNumber = GREATEST(lastNumber, target). */
  advanceSequenceTip(tenantId: UUID, entityType: string, prefix: string, target: number): Promise<void>;
  deviceBelongsToTenant(tenantId: string, syncDeviceId: string): Promise<boolean>;
}
