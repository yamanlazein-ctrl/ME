import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { VoucherData, CreateVoucherInput } from "../../domain/entities/Voucher.js";

export interface VoucherFilter {
  /** Keyset cursor ("load every row" callers) — see keysetPage.ts. */
  cursor?: string;
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
  create(input: CreateVoucherInput, ctx: TenantContext): Promise<VoucherData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext, expectedVersion: number): Promise<VoucherData>;

  // ── Multi-invoice settlement reads (moved from settleInvoicesUseCase, S1) ──
  /** Invoices selected for a settlement (tenant-scoped; any status). */
  settlementInvoices(ids: string[], ctx: TenantContext): Promise<SettlementInvoiceRow[]>;
  /** Active return totals per original invoice: SUM(ROUND(kg × price, 2)) per invoice. */
  settlementReturnTotals(ids: string[], ctx: TenantContext): Promise<Array<{ invoiceId: string | null; total: number | string | null }>>;
  /** Allocate the SET batch number in its OWN transaction (autonomous commit, research I-2). */
  allocateSettlementBatchNumber(ctx: TenantContext): Promise<string>;
}

export interface SettlementInvoiceRow {
  id: string;
  number: string;
  date: string;
  total: number;
  paid: number;
  status: string;
  currency: string;
  partyId: string;
}
