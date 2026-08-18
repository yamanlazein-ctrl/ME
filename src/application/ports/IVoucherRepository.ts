import { Voucher } from "@/domain/entities/Voucher";
import { VoucherFilter } from "@/core/dtos/VoucherDTO";
import { PaginatedResult, TenantContext, UUID } from "@/domain/types";

export interface IVoucherRepository {
  findById(id: UUID, ctx: TenantContext): Promise<Voucher | null>;
  list(filter: VoucherFilter, ctx: TenantContext): Promise<PaginatedResult<Voucher>>;
  create(voucher: Voucher, ctx: TenantContext): Promise<Voucher>;
  cancel(id: UUID, ctx: TenantContext): Promise<void>;
  vouchersOfInvoice(invoiceId: UUID, ctx: TenantContext): Promise<Voucher[]>;
}
