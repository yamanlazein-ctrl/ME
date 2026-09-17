import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  InvoiceDTO,
  CreateInvoiceRequest,
  InvoiceFilter,
  ListInvoicesResponse,
} from "@/contracts/invoices";

export class InvoiceApiService {
  constructor(private client: BaseHttpClient) {}

  async list(filter?: InvoiceFilter): Promise<ListInvoicesResponse> {
    const res = await this.client.get<ListInvoicesResponse>("/api/invoices", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(id: string): Promise<InvoiceDTO> {
    const res = await this.client.get<InvoiceDTO>(`/api/invoices/${id}`);
    return res.data;
  }

  async findByNumber(number: string): Promise<InvoiceDTO> {
    const res = await this.client.get<InvoiceDTO>(`/api/invoices/number/${number}`);
    return res.data;
  }

  async create(input: CreateInvoiceRequest): Promise<InvoiceDTO> {
    const res = await this.client.post<InvoiceDTO>("/api/invoices", input);
    return res.data;
  }

  async update(
    id: string,
    input: Partial<CreateInvoiceRequest> & { expectedVersion: number },
  ): Promise<InvoiceDTO> {
    const res = await this.client.put<InvoiceDTO>(`/api/invoices/${id}`, input);
    return res.data;
  }

  async cancel(id: string, expectedVersion: number): Promise<InvoiceDTO> {
    const res = await this.client.post<InvoiceDTO>(`/api/invoices/${id}/cancel`, {
      expectedVersion,
    });
    return res.data;
  }

  /**
   * #7: READ-ONLY preview of the next server-side invoice number
   * (document_sequences). Does not consume a number — the real number is
   * still allocated atomically at save time.
   */
  async nextNumber(
    type: "sale" | "entry",
  ): Promise<{ data: { number: string; estimate: boolean } }> {
    return this.client.get<{ number: string; estimate: boolean }>(
      "/api/invoices/next-number",
      { params: { type } },
    );
  }
}
