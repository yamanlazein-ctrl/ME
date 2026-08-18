import { Invoice, InvoiceData, InvoiceLineData } from "@/domain/entities/Invoice";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import { PaginatedResult, PaginationParams } from "@/domain/types";

/**
 * Port: InvoiceRepository — contract between application and infrastructure.
 * Implementations must enforce tenant isolation (RLS in DB layer).
 */
export interface IInvoiceRepository {
  /**
   * Fetch a single invoice including its lines.
   */
  findById(id: UUID, ctx: TenantContext): Promise<Invoice | null>;

  /**
   * Fetch by human-readable number (INV-000123).
   */
  findByNumber(number: string, ctx: TenantContext): Promise<Invoice | null>;

  /**
   * Paginated list with optional filters.
   */
  list(filter: InvoiceFilter, ctx: TenantContext): Promise<PaginatedResult<Invoice>>;

  /**
   * Persist a brand-new invoice.
   */
  create(invoice: Invoice, ctx: TenantContext): Promise<Invoice>;

  /**
   * Update mutable fields (notes, status). Returns updated entity.
   */
  update(
    id: UUID,
    patch: Partial<Omit<InvoiceData, "id" | "tenantId" | "number" | "type">>,
    ctx: TenantContext,
  ): Promise<Invoice>;

  /**
   * Soft-cancel an active invoice. Returns the cancelled entity.
   * Throws DomainError if already cancelled or not found.
   */
  cancel(id: UUID, ctx: TenantContext): Promise<Invoice>;
}

/**
 * Filter shape for querying invoices.
 */
export interface InvoiceFilter extends PaginationParams {
  partyId?: UUID;
  type?: Invoice["type"];
  status?: Invoice["status"];
  fromDate?: string; // yyyy-mm-dd
  toDate?: string; // yyyy-mm-dd
  currency?: string;
  search?: string;
  page?: number;
}
