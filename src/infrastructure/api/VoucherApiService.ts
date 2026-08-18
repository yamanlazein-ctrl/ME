import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  PaymentDTO,
  CreatePaymentRequest,
  PaymentFilter,
  ListPaymentsResponse,
} from "@/contracts/payments";
import type {
  ReceiptDTO,
  CreateReceiptRequest,
  ReceiptFilter,
  ListReceiptsResponse,
} from "@/contracts/receipts";
import type { UUID } from "@/domain/types";

export class VoucherApiService {
  constructor(private client: BaseHttpClient) {}

  /* ── Payments ─────────────────────────────────────────────────── */
  async listPayments(filter?: PaymentFilter): Promise<ListPaymentsResponse> {
    const res = await this.client.get<ListPaymentsResponse>("/api/payments", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findPaymentById(id: UUID): Promise<PaymentDTO> {
    const res = await this.client.get<PaymentDTO>(`/api/payments/${id}`);
    return res.data;
  }

  async createPayment(input: CreatePaymentRequest): Promise<PaymentDTO> {
    const res = await this.client.post<PaymentDTO>("/api/payments", input);
    return res.data;
  }

  async cancelPayment(id: UUID): Promise<void> {
    await this.client.post(`/api/payments/${id}/cancel`);
  }

  /* ── Receipts ─────────────────────────────────────────────────── */
  async listReceipts(filter?: ReceiptFilter): Promise<ListReceiptsResponse> {
    const res = await this.client.get<ListReceiptsResponse>("/api/receipts", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findReceiptById(id: UUID): Promise<ReceiptDTO> {
    const res = await this.client.get<ReceiptDTO>(`/api/receipts/${id}`);
    return res.data;
  }

  async createReceipt(input: CreateReceiptRequest): Promise<ReceiptDTO> {
    const res = await this.client.post<ReceiptDTO>("/api/receipts", input);
    return res.data;
  }

  async cancelReceipt(id: UUID): Promise<void> {
    await this.client.post(`/api/receipts/${id}/cancel`);
  }
}
