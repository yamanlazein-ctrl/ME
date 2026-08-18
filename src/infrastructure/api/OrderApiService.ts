import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  OrderDTO,
  CreateOrderInput,
  OrderFilter,
  ListOrdersResponse,
  FulfillOrderRequest,
} from "@/contracts/orders";

export class OrderApiService {
  constructor(private client: BaseHttpClient) {}

  async list(filter?: OrderFilter): Promise<ListOrdersResponse> {
    const res = await this.client.get<ListOrdersResponse>("/api/orders", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(id: string): Promise<OrderDTO> {
    const res = await this.client.get<OrderDTO>(`/api/orders/${id}`);
    return res.data;
  }

  async findByCode(code: string): Promise<OrderDTO> {
    const res = await this.client.get<OrderDTO>("/api/orders/by-code", { params: { code } });
    return res.data;
  }

  async create(input: CreateOrderInput): Promise<OrderDTO> {
    const res = await this.client.post<OrderDTO>("/api/orders", input);
    return res.data;
  }

  async update(id: string, input: Partial<OrderDTO>): Promise<OrderDTO> {
    const res = await this.client.put<OrderDTO>(`/api/orders/${id}`, input);
    return res.data;
  }

  async cancel(id: string): Promise<OrderDTO> {
    const res = await this.client.post<OrderDTO>(`/api/orders/${id}/cancel`);
    return res.data;
  }

  async fulfill(id: string, invoiceId: string): Promise<OrderDTO> {
    const req: FulfillOrderRequest = { invoiceId };
    const res = await this.client.post<OrderDTO>(`/api/orders/${id}/fulfill`, req);
    return res.data;
  }
}
