import { Fabric, type FabricData } from "@/domain/entities/Fabric";
import { Color, type ColorData } from "@/domain/entities/Color";
import { Roll, type RollData } from "@/domain/entities/Roll";
import { TenantContext, UUID } from "@/domain/types";
import { Ok, Err, type Result } from "@/core/result";
import {
  NotFoundError,
  InsufficientStockError,
  ConcurrentModificationError,
} from "@/domain/errors";
import type {
  IInventoryRepository,
  InventoryFilter,
} from "@/application/ports/IInventoryRepository";
import type { PaginatedResult } from "@/domain/types";
import { InventoryApiService } from "@/infrastructure/api";

export class ApiInventoryRepository implements IInventoryRepository {
  constructor(private api: InventoryApiService) {}

  async createFabric(
    props: Omit<FabricData, "id" | "createdAt">,
    ctx: TenantContext,
  ): Promise<Fabric> {
    const dto = await this.api.createFabric(props as FabricData);
    return Fabric.reconstitute(dto);
  }

  async listFabrics(filter: InventoryFilter, ctx: TenantContext): Promise<PaginatedResult<Fabric>> {
    const res = await this.api.listFabrics(filter as Record<string, string>);
    const data = res.data.map((dto: FabricData) => Fabric.reconstitute(dto));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async updateFabric(
    id: UUID,
    patch: Partial<
      Omit<FabricData, "id" | "tenantId" | "createdAt" | "createdBy">
    >,
    ctx: TenantContext,
  ): Promise<Fabric> {
    const dto = await this.api.updateFabric(id, patch as FabricData);
    return Fabric.reconstitute(dto);
  }

  async deleteFabric(id: UUID, ctx: TenantContext): Promise<boolean> {
    try {
      await this.api.deleteFabric(id);
      return true;
    } catch {
      return false;
    }
  }

  async createColor(
    props: Omit<ColorData, "id" | "createdAt">,
    ctx: TenantContext,
  ): Promise<Color> {
    const dto = await this.api.createColor(props as ColorData);
    return Color.reconstitute(dto);
  }

  async listColors(filter: InventoryFilter, ctx: TenantContext): Promise<PaginatedResult<Color>> {
    const res = await this.api.listColors(filter as Record<string, string>);
    const data = res.data.map((dto: ColorData) => Color.reconstitute(dto));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async updateColor(
    id: UUID,
    patch: Partial<Omit<ColorData, "id" | "tenantId" | "fabricId" | "createdAt">>,
    ctx: TenantContext,
  ): Promise<Color> {
    const dto = await this.api.updateColor(id, patch as ColorData);
    return Color.reconstitute(dto);
  }

  async deleteColor(id: UUID, ctx: TenantContext): Promise<boolean> {
    try {
      await this.api.deleteColor(id);
      return true;
    } catch {
      return false;
    }
  }

  async createRoll(
    props: Omit<RollData, "id" | "createdAt" | "remainingKg" | "version">,
    ctx: TenantContext,
  ): Promise<Roll> {
    const dto = await this.api.createRoll(props as RollData);
    return Roll.reconstitute(dto);
  }

  async findRollById(id: UUID, ctx: TenantContext): Promise<Roll | null> {
    try {
      const dto = await this.api.getRoll(id);
      return Roll.reconstitute(dto);
    } catch (e) {
      console.warn("[ApiRepo] findRollById failed", e);
      return null;
    }
  }

  async listRolls(filter: InventoryFilter, ctx: TenantContext): Promise<PaginatedResult<Roll>> {
    const res = await this.api.listRolls(filter as Record<string, string>);
    const data = res.data.map((dto) => Roll.reconstitute(dto));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async updateRoll(
    id: UUID,
    patch: Partial<Omit<RollData, "id" | "tenantId" | "colorId" | "createdAt" | "version">>,
    ctx: TenantContext,
  ): Promise<Roll> {
    const dto = await this.api.updateRoll(id, patch as RollData);
    return Roll.reconstitute(dto);
  }

  async deleteRoll(id: UUID, ctx: TenantContext): Promise<boolean> {
    try {
      await this.api.deleteRoll(id);
      return true;
    } catch {
      return false;
    }
  }

  async reserveStock(
    rollId: UUID,
    quantityKg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Result<void, NotFoundError | InsufficientStockError | ConcurrentModificationError>> {
    try {
      await this.api.reserveStock(rollId, quantityKg, expectedVersion);
      return Ok(undefined);
    } catch (e) {
      return Err(e as NotFoundError | InsufficientStockError | ConcurrentModificationError);
    }
  }

  async releaseStock(
    rollId: UUID,
    quantityKg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Result<void, NotFoundError | InsufficientStockError | ConcurrentModificationError>> {
    try {
      await this.api.releaseStock(rollId, quantityKg, expectedVersion);
      return Ok(undefined);
    } catch (e) {
      return Err(e as NotFoundError | InsufficientStockError | ConcurrentModificationError);
    }
  }
}
