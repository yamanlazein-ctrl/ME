import type { UUID } from "../../domain/types/index.js";

export interface SyncResourceClaimRow {
  id: UUID;
  tenantId: UUID;
  resourceType: string;
  resourceId: UUID;
  /**
   * Reserved kilograms / pieces for stock resources (roll/invoice_update_roll/
   * return_roll). Both NULL = identity guard (single winner per resource).
   */
  quantityKg: number | null;
  quantityPieces: number | null;
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
  resources: Array<{
    resourceType: string;
    resourceId: UUID;
    quantityKg?: number | null;
    quantityPieces?: number | null;
  }>;
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
        /** Hub stock remaining at decision time (quantity conflicts only). */
        availableKg?: number | null;
        /** Requested kilograms that did not fit (quantity conflicts only). */
        requestedKg?: number | null;
        /** Hub pieces remaining at decision time (quantity conflicts only). */
        availablePieces?: number | null;
        /** Requested pieces that did not fit (quantity conflicts only). */
        requestedPieces?: number | null;
        /**
         * Why the unit lost: a live holder's reservation (`held`), or plain
         * insufficient stock with no holder to blame (`insufficient-stock`).
         */
        reason?: "held" | "insufficient-stock";
      }>;
    };

export interface ISyncResourceClaimRepository {
  tryClaimAll(input: TryClaimResourcesInput): Promise<TryClaimResourcesResult>;
  listByOp(tenantId: UUID, opId: UUID): Promise<SyncResourceClaimRow[]>;
  /**
   * Operator inventory: every outstanding first-write-wins claim in the
   * tenant, oldest first. Without this a claim stranded by a crash (claim
   * written, materialize never applied, release never ran) is invisible and
   * every later touch of the resource 409s with no diagnosis path.
   */
  listByTenant(tenantId: UUID, limit?: number): Promise<SyncResourceClaimRow[]>;
  /**
   * Release the claims a document holds over shared resources — e.g. the rolls
   * an invoice consumed.
   *
   * Without this a cancelled invoice keeps `roll:<id>` claimed forever, so
   * every later sale of that roll from ANY device is rejected as a conflict.
   * The system degrades permanently and the roll becomes unsellable.
   *
   * @param resourceTypes restrict the release (e.g. only roll claims); when
   *        omitted every claim held by that document is released.
   * @returns number of claims actually removed.
   */
  releaseByEntity(
    tenantId: UUID,
    entityType: string,
    entityId: UUID,
    resourceTypes?: string[],
  ): Promise<number>;
  /**
   * Release every claim held by one sync operation id.
   *
   * This is the ONLY safe reap primitive: it targets the exact op whose hub
   * inbox row reached a terminal state (`dead`), so a live unit's claims can
   * never be touched. Releasing by resource or by age would break
   * determinism — a TTL reap could free a claim for a unit that is still
   * retrying and let a second writer through.
   *
   * @returns number of claims actually removed.
   */
  releaseByOp(tenantId: UUID, opId: UUID): Promise<number>;
}
