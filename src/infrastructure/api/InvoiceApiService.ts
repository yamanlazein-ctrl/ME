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

  async update(id: string, input: Partial<CreateInvoiceRequest>): Promise<InvoiceDTO> {
    const res = await this.client.put<InvoiceDTO>(`/api/invoices/${id}`, input);
    return res.data;
  }

  async cancel(id: string): Promise<InvoiceDTO> {
    const res = await this.client.post<InvoiceDTO>(`/api/invoices/${id}/cancel`);
    return res.data;
  }
}
