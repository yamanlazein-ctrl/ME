import { Result, Ok, Err } from "@/core/result";
import { Invoice, InvoiceData } from "@/domain/entities/Invoice";
import { ValidationError } from "@/domain/errors";
import { InvoiceCreated } from "@/domain/events";
import { TenantContext } from "@/domain/types";
import { IInvoiceRepository } from "@/application/ports/IInvoiceRepository";

/**
 * Create an invoice through the persistence layer.
 *
 * Stock reservation/deduction and the initial ledger entry are performed by
 * the backend transaction (sale invoices deduct rolls, entry invoices debit
 * the supplier, sale invoices credit the customer). This use case only
 * validates the input and persists the invoice.
 */
export class CreateInvoiceUseCase {
  constructor(private readonly invoices: IInvoiceRepository) {}

  async execute(
    input: Omit<
      InvoiceData,
      "id" | "status" | "version" | "cancelledAt" | "createdAt" | "createdBy"
    >,
    ctx: TenantContext,
  ): Promise<Result<Invoice, ValidationError>> {
    if (!input.partyId) {
      return Err(new ValidationError("طرف الفاتورة مطلوب", "partyId"));
    }
    if (!input.lines?.length) {
      return Err(new ValidationError("يجب إضافة سطر واحد على الأقل.", "lines"));
    }

    for (const line of input.lines) {
      if (line.quantityKg <= 0) {
        return Err(new ValidationError("الكمية يجب أن تكون أكبر من صفر.", "quantityKg"));
      }
      if (line.pricePerKg < 0) {
        return Err(new ValidationError("سعر الكيلو يجب ألا يكون سالباً.", "pricePerKg"));
      }
    }

    /* Build domain entity */
    const invoice = Invoice.create({
      ...input,
      tenantId: ctx.tenantId,
      createdBy: ctx.userName,
      createdAt: new Date().toISOString(),
    });

    /* Persist invoice (backend handles stock + ledger atomically) */
    const saved = await this.invoices.create(invoice, ctx);

    /* Dispatch domain event */
    const event = InvoiceCreated(ctx.tenantId, {
      invoiceId: saved.id,
      number: saved.number,
      type: saved.type,
      partyId: saved.partyId,
      totalAmount: saved.total(),
      currency: saved.currency,
    });
    console.debug("[DomainEvent]", event.type, event.payload);

    return Ok(saved);
  }
}
