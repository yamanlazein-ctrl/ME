import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  CashboxStateDTO,
  ManualMovementDTO,
  DailyClosingDTO,
  CreateManualMovementRequest,
  CloseDayRequest,
  DayCashFlowDTO,
} from "@/contracts/cashbox";

export class CashboxApiService {
  constructor(private client: BaseHttpClient) {}

  async getState(): Promise<CashboxStateDTO> {
    const res = await this.client.get<CashboxStateDTO>("/api/cashbox/state");
    return res.data;
  }

  async setOpeningBalance(
    balance: number,
    openingDate: string,
    currency?: string,
  ): Promise<void> {
    await this.client.post("/api/cashbox/opening-balance", {
      openingBalance: balance,
      openingDate,
      currency,
    });
  }

  async cashBalanceOn(date: string, currency?: string): Promise<number> {
    const q = currency ? `?currency=${encodeURIComponent(currency)}` : "";
    const res = await this.client.get<number>(
      `/api/cashbox/balance/${date}${q}`,
    );
    return res.data;
  }

  async cashMovementsOn(date: string): Promise<DayCashFlowDTO> {
    const res = await this.client.get<DayCashFlowDTO>(
      `/api/cashbox/movements/${date}`,
    );
    return res.data;
  }

  async isDayLocked(date: string): Promise<boolean> {
    const res = await this.client.get<boolean>(`/api/cashbox/locked/${date}`);
    return res.data;
  }

  async listManualMovements(): Promise<ManualMovementDTO[]> {
    const res = await this.client.get<ManualMovementDTO[]>(
      "/api/cashbox/manual-movements",
    );
    return res.data;
  }

  async addManualMovement(
    input: CreateManualMovementRequest,
  ): Promise<ManualMovementDTO> {
    const res = await this.client.post<ManualMovementDTO>(
      "/api/cashbox/manual-movements",
      input,
    );
    return res.data;
  }

  async deleteManualMovement(id: string): Promise<void> {
    await this.client.delete(`/api/cashbox/manual-movements/${id}`);
  }

  async closeDay(input: CloseDayRequest): Promise<DailyClosingDTO> {
    const res = await this.client.post<DailyClosingDTO>(
      "/api/cashbox/close-day",
      input,
    );
    return res.data;
  }

  async listClosings(): Promise<DailyClosingDTO[]> {
    const res = await this.client.get<DailyClosingDTO[]>(
      "/api/cashbox/closings",
    );
    return res.data;
  }

  async lastClosing(): Promise<DailyClosingDTO | null> {
    try {
      const res = await this.client.get<DailyClosingDTO>(
        "/api/cashbox/closings/last",
      );
      return res.data ?? null;
    } catch {
      return null;
    }
  }
}
