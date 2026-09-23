import { Invoice, type InvoiceData } from "@/domain/entities/Invoice";
import { TenantContext, UUID } from "@/domain/types";
import type { IInvoiceRepository, InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { InvoiceDTO, CreateInvoiceRequest } from "@/contracts/invoices";
import { InvoiceApiService } from "@/infrastructure/api";

export class ApiInvoiceRepository implements IInvoiceRepository {
  constructor(private api: InvoiceApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<Invoice | null> {
    void ctx;
    try {
      const dto = await this.api.findById(id);
      return Invoice.reconstitute(dto as unknown as InvoiceData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404)
        return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async findByNumber(number: string, ctx: TenantContext): Promise<Invoice | null> {
    void ctx;
    try {
      const dto = await this.api.findByNumber(number);
      return Invoice.reconstitute(dto as unknown as InvoiceData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404)
        return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
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
      reference: invoice.reference ?? undefined,
      /** Units of `currency` per 1 USD — frozen at creation (required for non-USD). */
      exchangeRate: invoice.exchangeRate ?? undefined,
      discount: invoice.discount,
      tax: invoice.tax,
      shipping: invoice.shipping,
      paid: invoice.paid,
      ...(invoice.creditApplied ? { creditApplied: invoice.creditApplied } : {}),
      paymentMethod: invoice.paymentMethod,
      orderId: invoice.orderId,
      lines: invoice.lines.map((l) => ({
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        // Dual-unit stock: pieces MUST reach the backend or the entry-invoice
        // increment (rolls.remaining_pieces += line.pieces ?? 1) defaults to +1.
        pieces: l.pieces ?? 1,
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
    const current = await this.findById(id, ctx);
    const expectedVersion =
      typeof (patch as { version?: number }).version === "number"
        ? (patch as { version: number }).version
        : current?.version;
    if (typeof expectedVersion !== "number") {
      throw new Error("الإصدار المتوقع (expectedVersion) مطلوب لتحديث الفاتورة");
    }
    const { version: _dropped, ...rest } = patch as Record<string, unknown>;
    void _dropped;
    const dto = await this.api.update(id, { ...rest, expectedVersion } as never);
    return Invoice.reconstitute(dto as unknown as InvoiceData);
  }

  async cancel(id: UUID, ctx: TenantContext, expectedVersion: number): Promise<Invoice> {
    void ctx;
    const dto = await this.api.cancel(id, expectedVersion);
    return Invoice.reconstitute(dto as unknown as InvoiceData);
  }
}
