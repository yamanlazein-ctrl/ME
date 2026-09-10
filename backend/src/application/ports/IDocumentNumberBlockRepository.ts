import type { UUID } from "../../domain/types/index.js";

export type DocumentNumberBlockStatus = "active" | "exhausted" | "reclaimed";

export interface DocumentNumberBlockRow {
  id: UUID;
  tenantId: UUID;
  syncDeviceId: UUID;
  entityType: string;
  year: number;
  prefix: string;
  startNumber: number;
  endNumber: number;
  nextNumber: number;
  status: DocumentNumberBlockStatus;
  claimedAt: Date;
  updatedAt: Date;
  reclaimedAt: Date | null;
}

export interface ClaimDocumentNumberBlockInput {
  tenantId: UUID;
  syncDeviceId: UUID;
  entityType: string;
  year: number;
  prefix: string;
  startNumber: number;
  endNumber: number;
}

export interface IDocumentNumberBlockRepository {
  findActive(
    tenantId: UUID,
    syncDeviceId: UUID,
    entityType: string,
    year: number,
  ): Promise<DocumentNumberBlockRow | null>;

  listForDevice(
    tenantId: UUID,
    syncDeviceId: UUID,
  ): Promise<DocumentNumberBlockRow[]>;

  insertClaimed(input: ClaimDocumentNumberBlockInput): Promise<DocumentNumberBlockRow>;

  /**
   * Atomically consume the next number from an active block.
   * Returns null if no capacity / year mismatch / missing block.
   */
  consumeNext(
    tenantId: UUID,
    syncDeviceId: UUID,
    entityType: string,
    year: number,
  ): Promise<{ numberValue: number; block: DocumentNumberBlockRow } | null>;

  /**
   * Reclaim unused tail when this block is still the tip of the global sequence.
   * Returns unused count (0 if nothing to reclaim).
   */
  reclaimTail(
    tenantId: UUID,
    blockId: UUID,
    currentGlobalLast: number,
  ): Promise<{ reclaimed: number; block: DocumentNumberBlockRow | null }>;
}
