import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { FabricData } from "../../domain/entities/Fabric.js";

export interface FabricFilter {
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateFabricData {
  name: string;
  category?: string;
  minStockKg?: number;
  unit?: string;
  notes?: string;
  imageUrl?: string;
}

export interface IFabricRepository {
  findById(id: string, ctx: TenantContext): Promise<FabricData | null>;
  list(filter: FabricFilter, ctx: TenantContext): Promise<PaginatedResult<FabricData>>;
  create(data: CreateFabricData, ctx: TenantContext): Promise<FabricData>;
  update(id: string, data: Partial<CreateFabricData>, ctx: TenantContext): Promise<FabricData>;
  delete(id: string, ctx: TenantContext): Promise<boolean>;
}
