import { Result, Ok, Err } from "@/core/result";
import { Invoice } from "@/domain/entities/Invoice";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { InvoiceCancelled } from "@/domain/events";
import { TenantContext, UUID } from "@/domain/types";
import { IInvoiceRepository } from "@/application/ports/IInvoiceRepository";

/**
 * Cancel an existing active invoice.
 *
 * Stock release and ledger reversal are performed by the backend transaction
 * (sale invoices release reserved roll stock, and the linked ledger entries
 * are cancelled). This use case only loads, validates, and persists.
 */
export class CancelInvoiceUseCase {
  constructor(private readonly invoices: IInvoiceRepository) {}

  async execute(
    id: UUID,
    ctx: TenantContext,
  ): Promise<Result<Invoice, NotFoundError | ValidationError>> {
    /* 1 — Load */
    const invoice = await this.invoices.findById(id, ctx);
    if (!invoice) {
      return Err(new NotFoundError("Invoice", id));
    }
    if (!invoice.canCancel()) {
      return Err(new ValidationError("لا يمكن إلغاء فاتورة أُلغي سابقاً."));
    }

    /* 2 — Cancel invoice (backend handles stock + ledger atomically) */
    await this.invoices.cancel(id, ctx);

    /* 3 — Dispatch domain event */
    const event = InvoiceCancelled(ctx.tenantId, {
      invoiceId: invoice.id,
      number: invoice.number,
      cancelledBy: ctx.userName,
    });
    console.debug("[DomainEvent]", event.type, event.payload);

    /* 4 — Refetch to get updated state */
    const updated = await this.invoices.findById(id, ctx);
    return Ok(updated!);
  }
}
