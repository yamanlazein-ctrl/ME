import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  LedgerEntryDTO,
  LedgerFilter,
  ListLedgerResponse,
  BalanceResponse,
  CashMovementsResponse,
} from "@/contracts/ledger";

export class LedgerApiService {
  constructor(private client: BaseHttpClient) {}

  async list(filter?: LedgerFilter): Promise<ListLedgerResponse> {
    const res = await this.client.get<ListLedgerResponse>("/api/ledger", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(id: string): Promise<LedgerEntryDTO> {
    const res = await this.client.get<LedgerEntryDTO>(`/api/ledger/${id}`);
    return res.data;
  }

  async balance(partyId: string, currency: string): Promise<BalanceResponse> {
    const res = await this.client.get<BalanceResponse>(`/api/ledger/balance/${partyId}`, {
      params: { currency },
    });
    return res.data;
  }

  async cashMovementsOn(date: string, currency: string): Promise<CashMovementsResponse> {
    const res = await this.client.get<CashMovementsResponse>(`/api/ledger/cash-movements/${date}`, {
      params: { currency },
    });
    return res.data;
  }
}
