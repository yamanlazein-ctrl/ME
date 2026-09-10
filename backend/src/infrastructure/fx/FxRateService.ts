import { z } from "zod";
import { logger } from "../config/logger.js";

/**
 * FxRateService — reference USD→SYP rate for the HEADER widget.
 *
 * ⛔ GOVERNING RULE (settled project decision — do not violate):
 * This service exists ONLY to feed an informational, display-only badge in
 * the app header ("سعر الصرف المرجعي"). Its data must NEVER be used to
 * auto-fill any `exchangeRate` field on invoices, vouchers, or any other
 * accounting document. The user always types the exchange rate manually on
 * every invoice. Keep this module isolated from all billing logic.
 *
 * Fetch strategy (provider requirement + UX):
 * - The ONLY caller of the external provider (LiraScope) is this backend
 *   service, on a timer, storing the last known rate in an in-memory cache.
 * - Browsers never hit the provider directly: the frontend calls the internal
 *   endpoint GET /api/fx/reference-rate, which serves the cached snapshot.
 *   This protects against provider-side rate limiting, avoids CORS, and keeps
 *   page loads free of any external request.
 * - Failures are swallowed into the snapshot (available/stale flags) so the
 *   UI can degrade gracefully; nothing here can break a page render.
 */

const DEFAULT_UPSTREAM_URL =
  "https://lirascope.syria-cloud.sy/api/v1/rates/latest?currencies=USD&lang=ar";
// Provider free tier: keep a modest cadence (15 min).
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
// A cached rate older than this is flagged "stale" so the UI can tint it.
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const SOURCE_NAME = "LiraScope";
const SOURCE_URL = "https://lirascope.syria-cloud.sy";

const rateRowSchema = z.object({
  currency: z.string().min(1),
  buy: z.number().finite().positive(),
  sell: z.number().finite().positive(),
  mid: z.number().finite().positive(),
  timestampUtc: z.string().optional(),
  isManualOverride: z.boolean().optional(),
});

const upstreamResponseSchema = z.object({
  timestampUtc: z.string().optional(),
  cbsRates: z.array(rateRowSchema).optional(),
  marketRates: z.array(rateRowSchema).optional(),
  effectiveRates: z.array(rateRowSchema).optional(),
});

function pickUsdRate(
  parsed: z.infer<typeof upstreamResponseSchema>,
): z.infer<typeof rateRowSchema> | null {
  // Prefer effective (manual override or market), then market, then CBS.
  for (const pool of [parsed.effectiveRates, parsed.marketRates, parsed.cbsRates]) {
    const usd = pool?.find((r) => r.currency.toUpperCase() === "USD");
    if (usd) return usd;
  }
  return null;
}

export type FxRateSnapshot = {
  /** true when we have a rate worth showing (fresh or stale). */
  available: boolean;
  /** true when the shown rate is older than staleAfterMs. */
  stale: boolean;
  reason?: "NO_DATA" | "UPSTREAM_DOWN";
  rate?: { value: number; sell?: number; buy?: number };
  /** Provider-side timestamp, passed through verbatim when present. */
  priceUpdatedAt?: string;
  /** Our clock at the moment the rate was successfully fetched (ISO). */
  fetchedAt?: string;
  sourceName: string;
  sourceUrl: string;
};

export interface FxRateServiceOptions {
  upstreamUrl?: string;
  refreshIntervalMs?: number;
  fetchTimeoutMs?: number;
  staleAfterMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable monotonic-ish clock for tests (ms epoch). */
  now?: () => number;
}

type CachedRate = {
  value: number;
  sell?: number;
  buy?: number;
  priceUpdatedAt?: string;
  fetchedAt: string; // ISO
};

export class FxRateService {
  private readonly upstreamUrl: string;
  private readonly refreshIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private lastKnown?: CachedRate;
  private lastErrorAt?: string;
  private inFlight?: Promise<boolean>;
  private timer?: NodeJS.Timeout;

  constructor(options: FxRateServiceOptions = {}) {
    this.upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Start the background refresh loop. Never blocks startup and never throws. */
  start(): void {
    if (this.timer) return;
    // Initial fetch — fire and forget: server startup and page loads never
    // wait on the external provider.
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    // A display widget must never keep the Node process alive on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Fetch the upstream rate once, validate its shape, and update the cache.
   * Concurrent calls coalesce into a single upstream request.
   * Returns true when the cache was updated from a valid upstream payload.
   */
  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Current display snapshot. Always safe to render: when upstream data is
   * missing it reports `available: false` instead of throwing, so the UI can
   * show its graceful fallback message.
   */
  getSnapshot(): FxRateSnapshot {
    if (!this.lastKnown) {
      return {
        available: false,
        stale: false,
        reason: this.lastErrorAt ? "UPSTREAM_DOWN" : "NO_DATA",
        sourceName: SOURCE_NAME,
        sourceUrl: SOURCE_URL,
      };
    }
    const fetchedMs = Date.parse(this.lastKnown.fetchedAt);
    const stale = Number.isFinite(fetchedMs) && this.now() - fetchedMs > this.staleAfterMs;
    return {
      available: true,
      stale,
      rate: {
        value: this.lastKnown.value,
        sell: this.lastKnown.sell,
        buy: this.lastKnown.buy,
      },
      priceUpdatedAt: this.lastKnown.priceUpdatedAt,
      fetchedAt: this.lastKnown.fetchedAt,
      sourceName: SOURCE_NAME,
      sourceUrl: SOURCE_URL,
    };
  }

  private async doRefresh(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const res = await this.fetchImpl(this.upstreamUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`upstream responded with HTTP ${res.status}`);
      }
      const json: unknown = await res.json();
      // Shape validation: any schema drift from the provider is treated as a
      // failed fetch (last known price is kept, snapshot flags the problem).
      const parsed = upstreamResponseSchema.parse(json);
      const usd = pickUsdRate(parsed);
      if (!usd) {
        throw new Error("upstream payload has no USD rate");
      }
      this.lastKnown = {
        value: usd.mid,
        sell: usd.sell,
        buy: usd.buy,
        priceUpdatedAt: usd.timestampUtc ?? parsed.timestampUtc,
        fetchedAt: new Date(this.now()).toISOString(),
      };
      this.lastErrorAt = undefined;
      logger.debug({ value: usd.mid }, "FX reference rate updated (LiraScope)");
      return true;
    } catch (err) {
      this.lastErrorAt = new Date(this.now()).toISOString();
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "FX reference rate fetch failed — serving last known snapshot",
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
