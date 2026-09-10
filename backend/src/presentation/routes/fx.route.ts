import { Router, type RequestHandler } from "express";
import type { FxRateService } from "../../infrastructure/fx/FxRateService.js";

/**
 * FX reference-rate endpoint — HEADER DISPLAY-ONLY data source.
 *
 * ⛔ GOVERNING RULE (settled project decision — do not violate):
 * GET /api/fx/reference-rate serves the informational USD→SYP badge in the
 * app header. Its payload must NEVER be consumed by invoice/voucher logic or
 * used to pre-fill any `exchangeRate` field — users always type the exchange
 * rate manually on every invoice. The only consumer is the header widget.
 *
 * The external provider (LiraScope) is contacted exclusively by
 * FxRateService's background timer — never per request, never from a browser.
 * The response is always HTTP 200 with an `available` flag so the frontend
 * can render its graceful fallback without error-handling gymnastics.
 */
export function registerFxRoutes(
  apiRouter: Router,
  fxRateService: FxRateService,
  authMiddleware: RequestHandler,
): void {
  apiRouter.get("/fx/reference-rate", authMiddleware, (_req, res) => {
    try {
      res.status(200).json(fxRateService.getSnapshot());
    } catch {
      // Display widget must never 500 — degrade to empty snapshot.
      res.status(200).json({
        available: false,
        stale: false,
        reason: "NO_DATA",
        sourceName: "LiraScope",
        sourceUrl: "https://lirascope.syria-cloud.sy",
      });
    }
  });
}
