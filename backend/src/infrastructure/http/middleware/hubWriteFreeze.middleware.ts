import type { RequestHandler } from "express";

/**
 * MIG-04/05 — operator write freeze for a hub cutover or rollback (docs/HUB-MIGRATION-RUNBOOK.md).
 *
 * `HUB_WRITE_FREEZE=1` (an environment setting, so it survives restarts and redeploys) makes the
 * server read-only for business data: every mutation answers 503 HUB_WRITE_FROZEN. Devices treat a
 * 503 push as retryable and keep the unit pending (syncUseCases.ts isRetryablePushStatus), so no
 * offline change is lost while the old server is frozen, the final backup is taken, and the new
 * server is verified. Reads, sign-in, the integrity endpoints (fingerprint, preflight) and the hub
 * identity endpoints (epoch rotation is part of the runbook) stay available.
 */
export function isHubWriteFrozen(): boolean {
  return process.env.HUB_WRITE_FREEZE === "1";
}

const ALWAYS_ALLOWED = [
  "/api/auth/login",
  "/api/auth/pin-login",
  "/api/auth/refresh",
  "/api/auth/logout",
];

export function hubWriteFreezeGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isHubWriteFrozen()) return next();
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const path = req.path;
    if (
      ALWAYS_ALLOWED.includes(path) ||
      path.startsWith("/api/integrity") ||
      path.startsWith("/api/sync/hub/identity")
    ) {
      return next();
    }
    res.status(503).json({
      code: "HUB_WRITE_FROZEN",
      message:
        "الخادم في وضع النقل — الكتابة موقوفة مؤقتاً، وستُرسل التغييرات تلقائياً بعد انتهاء النقل.",
      statusCode: 503,
    });
  };
}
