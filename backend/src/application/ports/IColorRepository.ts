import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type { ColorData } from "../../domain/entities/Color.js";

export interface ColorFilter {
  fabricId?: UUID;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateColorData {
  fabricId: UUID;
  name: string;
  code?: string;
  hex?: string;
  imageUrl?: string;
}

export interface IColorRepository {
  findById(id: string, ctx: TenantContext): Promise<ColorData | null>;
  list(filter: ColorFilter, ctx: TenantContext): Promise<PaginatedResult<ColorData>>;
  create(data: CreateColorData, ctx: TenantContext): Promise<ColorData>;
  update(id: string, data: Partial<CreateColorData>, ctx: TenantContext): Promise<ColorData>;
  delete(id: string, ctx: TenantContext): Promise<boolean>;
}
