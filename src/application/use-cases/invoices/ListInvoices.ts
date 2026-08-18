import { Result, Ok } from "@/core/result";
import { Invoice } from "@/domain/entities/Invoice";
import { TenantContext } from "@/domain/types";
import { IInvoiceRepository, InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { PaginatedResult } from "@/domain/types";

/**
 * Query use-case: fetch a paginated list of invoices for the tenant.
 * Delegates to the repository — no business logic here.
 */
export class ListInvoicesUseCase {
  constructor(private readonly invoices: IInvoiceRepository) {}

  async execute(
    filter: InvoiceFilter,
    ctx: TenantContext,
  ): Promise<Result<PaginatedResult<Invoice>>> {
    const data = await this.invoices.list(filter, ctx);
    return Ok(data);
  }
}
