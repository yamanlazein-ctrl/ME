import type { BaseHttpClient } from "@/infrastructure/http";
import type { FabricData } from "@/domain/entities/Fabric";
import type { ColorData } from "@/domain/entities/Color";
import type { RollData } from "@/domain/entities/Roll";
import type {
  ListFabricsResponse,
  ListColorsResponse,
  ListRollsResponse,
  ReserveStockRequest,
  ReleaseStockRequest,
} from "@/contracts/inventory";

export class InventoryApiService {
  constructor(private client: BaseHttpClient) {}

  async listFabrics(filter?: Record<string, string>): Promise<ListFabricsResponse> {
    const res = await this.client.get<ListFabricsResponse>("/api/inventory/fabrics", {
      params: filter,
    });
    return res.data;
  }

  async createFabric(data: Omit<FabricData, "id" | "createdAt">): Promise<FabricData> {
    const res = await this.client.post<FabricData>("/api/inventory/fabrics", data);
    return res.data;
  }

  async updateFabric(id: string, patch: Partial<FabricData>): Promise<FabricData> {
    const res = await this.client.put<FabricData>(`/api/inventory/fabrics/${id}`, patch);
    return res.data;
  }

  async deleteFabric(id: string): Promise<void> {
    await this.client.delete(`/api/inventory/fabrics/${id}`);
  }

  async listColors(filter?: Record<string, string>): Promise<ListColorsResponse> {
    const res = await this.client.get<ListColorsResponse>("/api/inventory/colors", {
      params: filter,
    });
    return res.data;
  }

  async createColor(data: Omit<ColorData, "id" | "createdAt">): Promise<ColorData> {
    const res = await this.client.post<ColorData>("/api/inventory/colors", data);
    return res.data;
  }

  async updateColor(id: string, patch: Partial<ColorData>): Promise<ColorData> {
    const res = await this.client.put<ColorData>(`/api/inventory/colors/${id}`, patch);
    return res.data;
  }

  async deleteColor(id: string): Promise<void> {
    await this.client.delete(`/api/inventory/colors/${id}`);
  }

  async listRolls(filter?: Record<string, string>): Promise<ListRollsResponse> {
    const res = await this.client.get<ListRollsResponse>("/api/inventory/rolls", {
      params: filter,
    });
    return res.data;
  }

  async createRoll(
    data: Omit<RollData, "id" | "createdAt" | "remainingKg" | "version">,
  ): Promise<RollData> {
    const res = await this.client.post<RollData>("/api/inventory/rolls", data);
    return res.data;
  }

  async updateRoll(id: string, patch: Partial<RollData>): Promise<RollData> {
    const res = await this.client.put<RollData>(`/api/inventory/rolls/${id}`, patch);
    return res.data;
  }

  async deleteRoll(id: string): Promise<void> {
    await this.client.delete(`/api/inventory/rolls/${id}`);
  }

  async getRoll(id: string): Promise<RollData> {
    const res = await this.client.get<RollData>(`/api/inventory/rolls/${id}`);
    return res.data;
  }

  async reserveStock(rollId: string, quantityKg: number, expectedVersion: number): Promise<void> {
    await this.client.post(`/api/inventory/rolls/${rollId}/reserve`, {
      quantityKg,
      expectedVersion,
    } satisfies ReserveStockRequest);
  }

  async releaseStock(rollId: string, quantityKg: number, expectedVersion: number): Promise<void> {
    await this.client.post(`/api/inventory/rolls/${rollId}/release`, {
      quantityKg,
      expectedVersion,
    } satisfies ReleaseStockRequest);
  }
}
