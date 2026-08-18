import { Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import {
  NotFoundError,
  InsufficientStockError,
  ConcurrentModificationError,
} from "@/domain/errors";
import { Roll, RollData } from "@/domain/entities/Roll";

/**
 * Port: InventoryRepository — stock management with optimistic locking.
 */
export interface IInventoryRepository {
  /* ── Fabrics ──────────────────────────────────────────────────────── */

  createFabric(
    props: Omit<import("@/domain/entities/Fabric").FabricData, "id" | "createdAt">,
    ctx: TenantContext,
  ): Promise<import("@/domain/entities/Fabric").Fabric>;

  listFabrics(
    filter: InventoryFilter,
    ctx: TenantContext,
  ): Promise<import("@/domain/types").PaginatedResult<import("@/domain/entities/Fabric").Fabric>>;

  updateFabric(
    id: UUID,
    patch: Partial<
      Omit<import("@/domain/entities/Fabric").FabricData, "id" | "tenantId" | "createdAt" | "createdBy">
    >,
    ctx: TenantContext,
  ): Promise<import("@/domain/entities/Fabric").Fabric>;

  deleteFabric(id: UUID, ctx: TenantContext): Promise<boolean>;

  /* ── Colors ───────────────────────────────────────────────────────── */

  createColor(
    props: Omit<import("@/domain/entities/Color").ColorData, "id" | "createdAt">,
    ctx: TenantContext,
  ): Promise<import("@/domain/entities/Color").Color>;

  listColors(
    filter: InventoryFilter,
    ctx: TenantContext,
  ): Promise<import("@/domain/types").PaginatedResult<import("@/domain/entities/Color").Color>>;

  updateColor(
    id: UUID,
    patch: Partial<
      Omit<import("@/domain/entities/Color").ColorData, "id" | "tenantId" | "fabricId" | "createdAt">
    >,
    ctx: TenantContext,
  ): Promise<import("@/domain/entities/Color").Color>;

  deleteColor(id: UUID, ctx: TenantContext): Promise<boolean>;

  /* ── Rolls ────────────────────────────────────────────────────────── */

  createRoll(
    props: Omit<RollData, "id" | "createdAt" | "remainingKg" | "version">,
    ctx: TenantContext,
  ): Promise<Roll>;

  findRollById(id: UUID, ctx: TenantContext): Promise<Roll | null>;

  listRolls(
    filter: InventoryFilter,
    ctx: TenantContext,
  ): Promise<import("@/domain/types").PaginatedResult<Roll>>;

  updateRoll(
    id: UUID,
    patch: Partial<
      Omit<RollData, "id" | "tenantId" | "colorId" | "createdAt" | "version">
    >,
    ctx: TenantContext,
  ): Promise<Roll>;

  deleteRoll(id: UUID, ctx: TenantContext): Promise<boolean>;

  /**
   * Atomically reserve stock for an invoice line.
   * @throws InsufficientStockError — not enough remainingKg
   * @throws ConcurrentModificationError — version mismatch (someone else updated)
   */
  reserveStock(
    rollId: UUID,
    quantityKg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Result<void, NotFoundError | InsufficientStockError | ConcurrentModificationError>>;

  /**
   * Atomically release (restore) stock.
   * Idempotent — safe to call even if already released.
   */
  releaseStock(
    rollId: UUID,
    quantityKg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Result<void, NotFoundError | InsufficientStockError | ConcurrentModificationError>>;
}

export interface InventoryFilter {
  fabricId?: UUID;
  colorId?: UUID;
  supplierId?: UUID;
  status?: "active" | "low" | "out" | "all";
  search?: string;
  limit?: number;
  offset?: number;
}
