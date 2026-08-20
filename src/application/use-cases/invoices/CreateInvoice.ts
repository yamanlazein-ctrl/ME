import { Result, Ok, Err } from "@/core/result";
import { Invoice, InvoiceData } from "@/domain/entities/Invoice";
import { ValidationError } from "@/domain/errors";
import { InvoiceCreated } from "@/domain/events";
import { TenantContext } from "@/domain/types";
import { IInvoiceRepository } from "@/application/ports/IInvoiceRepository";
import { createInvoiceSchema } from "@erp/shared";

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
    const parsed = createInvoiceSchema.safeParse({
      type: input.type,
      date: input.date,
      partyId: input.partyId,
      partyType: input.partyType,
      currency: input.currency,
      lines: input.lines.map((l) => ({
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pieces: l.pieces,
        pricePerKg: l.pricePerKg,
        discountAmount: l.discountAmount,
        note: l.note,
      })),
      discount: input.discount,
      tax: input.tax,
      shipping: input.shipping,
      notes: input.notes,
      paid: input.paid,
      paymentMethod: input.paymentMethod,
      orderId: (input as unknown as { orderId?: string }).orderId,
    });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const field = first.path.join(".") || "unknown";
      return Err(new ValidationError(first.message, field));
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
