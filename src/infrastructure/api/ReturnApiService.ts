import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  ReturnDTO,
  CreateReturnRequest,
  ReturnFilter,
  ListReturnsResponse,
} from "@/contracts/returns";

export class ReturnApiService {
  constructor(private client: BaseHttpClient) {}

  async list(filter?: ReturnFilter): Promise<ListReturnsResponse> {
    const res = await this.client.get<ListReturnsResponse>("/api/returns", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(id: string): Promise<ReturnDTO> {
    const res = await this.client.get<ReturnDTO>(`/api/returns/${id}`);
    return res.data;
  }

  async create(input: CreateReturnRequest): Promise<ReturnDTO> {
    const res = await this.client.post<ReturnDTO>("/api/returns", input);
    return res.data;
  }

  async cancel(id: string): Promise<void> {
    await this.client.post(`/api/returns/${id}/cancel`);
  }
}
