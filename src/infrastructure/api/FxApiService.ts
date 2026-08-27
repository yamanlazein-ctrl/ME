import type { BaseHttpClient } from "@/infrastructure/http";

/**
 * FxApiService — client for the header's reference USD→SYP badge.
 *
 * ⛔ GOVERNING RULE (settled project decision — do not violate):
 * This service feeds a DISPLAY-ONLY header widget. Its data must NEVER be
 * used to pre-fill any `exchangeRate` field on invoices, vouchers, or any
 * accounting document — the user always types the exchange rate manually.
 * Keep it isolated from all billing logic.
 *
 * The browser only ever calls our internal backend endpoint (which serves a
 * server-side cached snapshot); it never contacts liranews.info directly.
 */
export interface FxReferenceRateResponse {
  /** true when we have a rate worth showing (fresh or stale). */
  available: boolean;
  /** true when the cached rate is older than the backend's stale threshold. */
  stale: boolean;
  reason?: "NO_DATA" | "UPSTREAM_DOWN";
  rate?: { value: number; sell?: number; buy?: number };
  /** Provider-side timestamp, verbatim when present. */
  priceUpdatedAt?: string;
  /** Backend clock when the rate was fetched (ISO) — used for "آخر تحديث". */
  fetchedAt?: string;
  sourceName: string;
  sourceUrl: string;
}

export class FxApiService {
  constructor(private client: BaseHttpClient) {}

  async getReferenceRate(): Promise<FxReferenceRateResponse> {
    const res = await this.client.get<FxReferenceRateResponse>("/api/fx/reference-rate");
    return res.data;
  }
}
