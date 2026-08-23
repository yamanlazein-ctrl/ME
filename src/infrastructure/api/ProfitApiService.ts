import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  ProfitSummaryDTO,
  ProfitDetailsDTO,
  ProfitQueryParams,
} from "@/contracts/profit";

/**
 * HTTP access to the server-authoritative profit endpoints.
 * All math lives in the backend (PostgresProfitRepository) — this service
 * only transports the query and the result. Currencies are never merged.
 */
export class ProfitApiService {
  constructor(private client: BaseHttpClient) {}

  private toParams(q?: ProfitQueryParams): Record<string, string> {
    const params: Record<string, string> = {};
    if (q?.fromDate) params.fromDate = q.fromDate;
    if (q?.toDate) params.toDate = q.toDate;
    if (q?.currency) params.currency = q.currency;
    return params;
  }

  async summary(q?: ProfitQueryParams): Promise<ProfitSummaryDTO> {
    const res = await this.client.get<ProfitSummaryDTO>("/api/profit/summary", {
      params: this.toParams(q),
    });
    return res.data;
  }

  async details(q?: ProfitQueryParams): Promise<ProfitDetailsDTO> {
    const res = await this.client.get<ProfitDetailsDTO>("/api/profit/details", {
      params: this.toParams(q),
    });
    return res.data;
  }
}