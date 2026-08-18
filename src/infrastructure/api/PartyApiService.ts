import type { BaseHttpClient } from "@/infrastructure/http";
import type { PartyDTO, PartyFilter } from "@/core/dtos/PartyDTO";
import type { ListResponse } from "@/contracts/_shared";

export class PartyApiService {
  constructor(private client: BaseHttpClient) {}

  private path(kind: "customer" | "supplier") {
    return `/api/${kind === "customer" ? "customers" : "suppliers"}`;
  }

  async list(kind: "customer" | "supplier", filter?: PartyFilter): Promise<ListResponse<PartyDTO>> {
    const res = await this.client.get<ListResponse<PartyDTO>>(this.path(kind), {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(kind: "customer" | "supplier", id: string): Promise<PartyDTO> {
    const res = await this.client.get<PartyDTO>(`${this.path(kind)}/${id}`);
    return res.data;
  }

  async findByCode(kind: "customer" | "supplier", code: string): Promise<PartyDTO> {
    const res = await this.client.get<PartyDTO>(`${this.path(kind)}/code/${code}`);
    return res.data;
  }

  async create(
    kind: "customer" | "supplier",
    input: Omit<PartyDTO, "id" | "createdAt">,
  ): Promise<PartyDTO> {
    const res = await this.client.post<PartyDTO>(this.path(kind), input);
    return res.data;
  }

  async update(
    kind: "customer" | "supplier",
    id: string,
    input: Partial<PartyDTO>,
  ): Promise<PartyDTO> {
    const res = await this.client.put<PartyDTO>(`${this.path(kind)}/${id}`, input);
    return res.data;
  }

  async delete(kind: "customer" | "supplier", id: string): Promise<void> {
    await this.client.delete(`${this.path(kind)}/${id}`);
  }
}
