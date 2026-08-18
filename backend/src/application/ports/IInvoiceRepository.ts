import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { InvoiceData, CreateInvoiceInput } from "../../domain/entities/Invoice.js";

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
  create(input: CreateInvoiceInput, autoNumber: string, ctx: TenantContext): Promise<InvoiceData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<InvoiceData>;
}
