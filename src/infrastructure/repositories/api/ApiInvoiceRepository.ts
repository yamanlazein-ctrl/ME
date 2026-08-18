import { Invoice, type InvoiceData } from "@/domain/entities/Invoice";
import { TenantContext, UUID } from "@/domain/types";
import type { IInvoiceRepository, InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { InvoiceDTO, CreateInvoiceRequest } from "@/contracts/invoices";
import { InvoiceApiService } from "@/infrastructure/api";

export class ApiInvoiceRepository implements IInvoiceRepository {
  constructor(private api: InvoiceApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<Invoice | null> {
    try {
      const dto = await this.api.findById(id);
      return Invoice.reconstitute(dto as unknown as InvoiceData);
    } catch (e) {
      console.warn("[ApiRepo] Invoice findById failed", e);
      return null;
    }
  }

  async findByNumber(number: string, ctx: TenantContext): Promise<Invoice | null> {
    try {
      const dto = await this.api.findByNumber(number);
      return Invoice.reconstitute(dto as unknown as InvoiceData);
    } catch (e) {
      console.warn("[ApiRepo] Invoice findByNumber failed", e);
      return null;
    }
  }

  async list(
    filter: InvoiceFilter,
    ctx: TenantContext,
  ): Promise<import("@/domain/types").PaginatedResult<Invoice>> {
    const res = await this.api.list(filter);
    const data = res.data.map((dto) => Invoice.reconstitute(dto as unknown as InvoiceData));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async create(invoice: Invoice, ctx: TenantContext): Promise<Invoice> {
    const input: CreateInvoiceRequest = {
      type: invoice.type,
      date: invoice.date,
      partyId: invoice.partyId,
      partyType: invoice.partyType,
      currency: invoice.currency,
      discount: invoice.discount,
      tax: invoice.tax,
      shipping: invoice.shipping,
      paid: invoice.paid,
      paymentMethod: invoice.paymentMethod,
      orderId: invoice.orderId,
      lines: invoice.lines.map((l) => ({
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pricePerKg: l.pricePerKg,
        discountAmount: l.discountAmount,
        note: l.note,
      })),
      notes: invoice.notes,
    };
    const dto = await this.api.create(input);
    return Invoice.reconstitute(dto as unknown as InvoiceData);
  }

  async update(
    id: UUID,
    patch: Partial<Omit<InvoiceData, "id" | "tenantId" | "number" | "type">>,
    ctx: TenantContext,
  ): Promise<Invoice> {
    const dto = await this.api.update(id, patch as Record<string, unknown>);
    return Invoice.reconstitute(dto as unknown as InvoiceData);
  }

  async cancel(id: UUID, ctx: TenantContext): Promise<Invoice> {
    const dto = await this.api.cancel(id);
    return Invoice.reconstitute(dto as unknown as InvoiceData);
  }
}
