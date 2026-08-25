import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type {
  InvoiceData,
  CreateInvoiceInput,
  UpdateInvoiceInput,
} from "../../domain/entities/Invoice.js";

export interface InvoiceFilter {
  partyId?: string;
  type?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface IInvoiceRepository {
  findById(id: string, ctx: TenantContext): Promise<InvoiceData | null>;
  findByNumber(number: string, type: string, ctx: TenantContext): Promise<InvoiceData | null>;
  list(filter: InvoiceFilter, ctx: TenantContext): Promise<PaginatedResult<InvoiceData>>;
  create(input: CreateInvoiceInput, ctx: TenantContext): Promise<InvoiceData>;
  /**
   * Edit an active invoice: applies per-roll stock deltas (entry +new-old,
   * sale old-new), replaces lines, and rewrites the ledger via reversal
   * entries (append-only trigger forbids UPDATE). partyId/type/currency/
   * paid are immutable — cancel & recreate instead.
   */
  update(id: string, input: UpdateInvoiceInput, ctx: TenantContext): Promise<InvoiceData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<InvoiceData>;
}
