import { Voucher, type VoucherData, type VoucherKind } from "@/domain/entities/Voucher";
import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type { VoucherFilter } from "@/core/dtos/VoucherDTO";
import type { IVoucherRepository } from "@/application/ports/IVoucherRepository";
import type { PaymentDTO } from "@/contracts/payments";
import type { ReceiptDTO } from "@/contracts/receipts";
import { VoucherApiService } from "@/infrastructure/api";

function paymentToVoucher(dto: PaymentDTO): Voucher {
  return Voucher.reconstitute({
    id: dto.id,
    tenantId: "" as UUID,
    number: dto.number,
    kind: "payment",
    date: dto.date,
    partyId: dto.partyId,
    partyKind: "supplier",
    invoiceId: dto.invoiceId ?? null,
    amount: dto.amount,
    currency: dto.currency,
    method: dto.method,
    notesPrint: dto.notesPrint ?? null,
    notesInternal: dto.notesInternal ?? null,
    attachments: [],
    status: dto.status,
    createdAt: dto.createdAt,
    createdBy: "",
    cancelledAt: null,
    cancelledBy: null,
  });
}

function receiptToVoucher(dto: ReceiptDTO): Voucher {
  return Voucher.reconstitute({
    id: dto.id,
    tenantId: "" as UUID,
    number: dto.number,
    kind: "receipt",
    date: dto.date,
    partyId: dto.partyId,
    partyKind: "customer",
    invoiceId: dto.invoiceId ?? null,
    amount: dto.amount,
    currency: dto.currency,
    method: dto.method,
    notesPrint: dto.notesPrint ?? null,
    notesInternal: dto.notesInternal ?? null,
    attachments: [],
    status: dto.status,
    createdAt: dto.createdAt,
    createdBy: "",
    cancelledAt: null,
    cancelledBy: null,
  });
}

export class ApiVoucherRepository implements IVoucherRepository {
  constructor(private api: VoucherApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<Voucher | null> {
    try {
      const payment = await this.api.findPaymentById(id);
      return paymentToVoucher(payment);
    } catch {
      /* try receipt */
    }
    try {
      const receipt = await this.api.findReceiptById(id);
      return receiptToVoucher(receipt);
    } catch (e) {
      console.warn("[ApiRepo] Voucher findById failed", e);
      return null;
    }
  }

  async list(filter: VoucherFilter, ctx: TenantContext): Promise<PaginatedResult<Voucher>> {
    const kind = filter.kind;
    const paymentFilter = kind === undefined || kind === "payment" ? filter : undefined;
    const receiptFilter = kind === undefined || kind === "receipt" ? filter : undefined;

    const [paymentsRes, receiptsRes] = await Promise.all([
      paymentFilter
        ? this.api.listPayments(paymentFilter)
        : Promise.resolve({
            data: [],
            meta: { total: 0, page: 0, limit: 0, hasNext: false, totalPages: 0 },
          }),
      receiptFilter
        ? this.api.listReceipts(receiptFilter)
        : Promise.resolve({
            data: [],
            meta: { total: 0, page: 0, limit: 0, hasNext: false, totalPages: 0 },
          }),
    ]);

    const data: Voucher[] = [
      ...paymentsRes.data.map(paymentToVoucher),
      ...receiptsRes.data.map(receiptToVoucher),
    ];
    const total = paymentsRes.meta.total + receiptsRes.meta.total;
    return { data, total, hasNext: paymentsRes.meta.hasNext || receiptsRes.meta.hasNext };
  }

  async create(voucher: Voucher, ctx: TenantContext): Promise<Voucher> {
    if (voucher.kind === "payment") {
      const dto = await this.api.createPayment({
        kind: "payment",
        date: voucher.date,
        partyId: voucher.partyId,
        partyKind: voucher.partyKind ?? "supplier",
        invoiceId: voucher.invoiceId ?? undefined,
        amount: voucher.amount,
        currency: voucher.currency,
        method: voucher.method,
        notesPrint: voucher.notesPrint ?? undefined,
        notesInternal: voucher.notesInternal ?? undefined,
      });
      return paymentToVoucher(dto);
    }
    const dto = await this.api.createReceipt({
      kind: "receipt",
      date: voucher.date,
      partyId: voucher.partyId,
      partyKind: voucher.partyKind ?? "customer",
      invoiceId: voucher.invoiceId ?? undefined,
      amount: voucher.amount,
      currency: voucher.currency,
      method: voucher.method,
      notesPrint: voucher.notesPrint ?? undefined,
      notesInternal: voucher.notesInternal ?? undefined,
    });
    return receiptToVoucher(dto);
  }

  async cancel(id: UUID, ctx: TenantContext): Promise<void> {
    await Promise.allSettled([this.api.cancelPayment(id), this.api.cancelReceipt(id)]);
  }

  async vouchersOfInvoice(invoiceId: UUID, ctx: TenantContext): Promise<Voucher[]> {
    const filter = { invoiceId, limit: 500 };
    const [paymentsRes, receiptsRes] = await Promise.all([
      this.api.listPayments(filter),
      this.api.listReceipts(filter),
    ]);
    return [...paymentsRes.data.map(paymentToVoucher), ...receiptsRes.data.map(receiptToVoucher)];
  }
}
