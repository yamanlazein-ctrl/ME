import type { BaseHttpClient } from "@/infrastructure/http";
import type { PartyDTO, PartyFilter } from "@/core/dtos/PartyDTO";
import type { ListResponse } from "@/contracts/_shared";
import type { PartyOpeningInput } from "@erp/shared";

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
    input: Partial<PartyDTO> & { expectedVersion: number },
  ): Promise<PartyDTO> {
    const res = await this.client.put<PartyDTO>(`${this.path(kind)}/${id}`, input);
    return res.data;
  }

  async setOpening(
    kind: "customer" | "supplier",
    id: string,
    body: { opening: PartyOpeningInput; expectedVersion: number },
  ): Promise<PartyDTO> {
    const res = await this.client.put<PartyDTO>(`${this.path(kind)}/${id}/opening`, body);
    return res.data;
  }

  async delete(kind: "customer" | "supplier", id: string, expectedVersion: number, confirmCascade = false): Promise<void> {
    // Query params duplicate the body so a transport that strips DELETE bodies
    // still carries the OCC token (desktop named-pipe + WebView2).
    await this.client.delete(`${this.path(kind)}/${id}`, {
      body: { expectedVersion, confirmCascade },
      params: {
        expectedVersion: String(expectedVersion),
        ...(confirmCascade ? { confirmCascade: "true" } : {}),
      },
    });
  }
}
