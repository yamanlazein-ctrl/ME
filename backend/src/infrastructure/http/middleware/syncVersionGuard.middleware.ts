import type { RequestHandler } from "express";
import { MONEY_RULES_VERSION } from "@erp/shared";

/**
 * BC-2 — money-version gate on sync push/pull (specs/002-mobile-app R6).
 *
 * A device that sends `X-Motard-Money-Version` must run the hub's money/rounding version; otherwise
 * the hub refuses with 426 so a phone with different rounding rules never syncs. A request with no
 * header passes (owner decision 2026-10-25): delivered desktops send none and keep syncing until
 * every desktop sends the header. A header that is not an integer is refused like a mismatch.
 */
export const syncVersionGuard: RequestHandler = (req, res, next) => {
  const raw = req.headers["x-motard-money-version"];
  if (raw === undefined) return next();
  const text = Array.isArray(raw) ? raw[0] : raw;
  const clientVersion =
    text !== undefined && /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  if (clientVersion === MONEY_RULES_VERSION) return next();
  res.status(426).json({
    code: "SYNC_VERSION_MISMATCH",
    message: "تحديث مطلوب",
    hubVersion: MONEY_RULES_VERSION,
    clientVersion: clientVersion ?? text ?? null,
  });
};
