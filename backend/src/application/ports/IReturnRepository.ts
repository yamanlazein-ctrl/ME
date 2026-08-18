import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type { ReturnData, CreateReturnInput } from "../../domain/entities/Return.js";

export interface ReturnFilter {
  kind?: string;
  partyId?: UUID;
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface IReturnRepository {
  findById(id: string, ctx: TenantContext): Promise<ReturnData | null>;
  list(filter: ReturnFilter, ctx: TenantContext): Promise<PaginatedResult<ReturnData>>;
  create(input: CreateReturnInput, autoNumber: string, ctx: TenantContext): Promise<ReturnData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<ReturnData>;
}
