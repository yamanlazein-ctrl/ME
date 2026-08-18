import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { VoucherData, CreateVoucherInput } from "../../domain/entities/Voucher.js";

export interface VoucherFilter {
  kind?: string;
  partyId?: string;
  invoiceId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface IVoucherRepository {
  findById(id: string, ctx: TenantContext): Promise<VoucherData | null>;
  list(filter: VoucherFilter, ctx: TenantContext): Promise<PaginatedResult<VoucherData>>;
  create(input: CreateVoucherInput, autoNumber: string, ctx: TenantContext): Promise<VoucherData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<VoucherData>;
}
