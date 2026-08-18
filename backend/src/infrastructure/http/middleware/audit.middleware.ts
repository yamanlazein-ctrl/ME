import type { Request, Response, NextFunction } from "express";
import type { IAuditRepository } from "../../../application/ports/IAuditRepository.js";

/**
 * Phase 0 sub-batch 0C — global audit middleware.
 *
 * Logs every non-GET request that mutates state, by calling
 * `auditRepo.create(...)` with the request method, path, and the
 * authenticated actor (from `req.tenantContext`).
 *
 * Skip rules (per PLATFORM_FOUNDATION_NOTES.md §1):
 *  - GET / HEAD / OPTIONS — read-only, no audit
 *  - The four already-audited route groups (invoices, expenses,
 *    returns, vouchers) call `auditRepo.create` from their use-case.
 *    To avoid double-writes, the middleware skips any path that
 *    starts with one of these prefixes.
 *  - Health and license admin endpoints are not part of the audit
 *    story in Phase 0.
 */
const SKIP_PATH_PREFIXES = [
  "/invoices",
  "/expenses",
  "/returns",
  "/payments",
  "/receipts", // voucher payments/receipts
  "/vouchers",
  "/api/health",
  "/api/admin/rotate-master-key", // writes its own audit
  "/api/setup", // setup wizard writes its own audit
  "/api/license", // license admin writes its own audit
];

const SKIP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createAuditMiddleware(auditRepo: IAuditRepository) {
  return async function auditMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (SKIP_METHODS.has(req.method)) {
        next();
        return;
      }
      if (SKIP_PATH_PREFIXES.some((p) => req.path.startsWith(p))) {
        next();
        return;
      }
      const ctx = req.tenantContext;
      if (!ctx) {
        // Unauthenticated requests should be blocked by the install
        // gate / auth middleware before they reach us; if they slip
        // through (e.g. misconfiguration), do not audit.
        next();
        return;
      }

      // Best-effort: a failure to write an audit row must NOT block
      // the request. We log and continue.
      auditRepo
        .create({
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorName: ctx.userName,
          module: "http",
          action: req.method.toLowerCase(),
          entityType: "request",
          entityId: undefined,
          detail: `${req.method} ${req.originalUrl}`,
          ipAddress: req.ip,
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[audit middleware] failed to write row:", err);
        });

      next();
    } catch (err) {
      next(err);
    }
  };
}
