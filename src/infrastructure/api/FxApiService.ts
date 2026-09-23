import type { BaseHttpClient } from "@/infrastructure/http";

/**
 * FxApiService — client for the reference USD→SYP rate.
 *
 * ⛔ GOVERNING RULE (settled project decision — do not violate):
 * This data must NEVER be used to pre-fill any `exchangeRate` field on
 * invoices, vouchers, or any accounting document — the user always types the
 * exchange rate manually.
 *
 * Originally this fed ONLY the display-only header badge (`FxReferenceRate`).
 * As of 2026-09-22 it also backs a narrow, explicitly-requested exception:
 * `useSypRateSoftCheck` compares a manually-typed SYP rate against this value
 * to show a dismissible "this looks off" warning (never a block, never a
 * write) — see that hook's docstring. That is the ONLY other permitted
 * consumer; still never auto-fill, never block, never silently substitute.
 *
 * The browser only ever calls our internal backend endpoint (which serves a
 * server-side cached snapshot); it never contacts LiraScope directly.
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
