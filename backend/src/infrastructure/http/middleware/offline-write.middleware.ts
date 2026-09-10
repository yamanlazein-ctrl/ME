import type { Request, Response, NextFunction } from "express";
import { canWriteOffline } from "../../../domain/sync/offlineWritePolicy.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * When the client signals offline mode (`X-Offline-Mode: 1`), block writes
 * for roles that are read-only offline (warehouse / viewer).
 */
export function offlineWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-offline-mode"] !== "1") {
    next();
    return;
  }
  if (!MUTATING.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const role = req.tenantContext?.userRole;
  if (!role || canWriteOffline(role)) {
    next();
    return;
  }
  res.status(403).json({
    code: "OFFLINE_WRITE_FORBIDDEN",
    message: "هذا الدور للقراءة فقط أثناء انقطاع الاتصال بالمزامنة",
    statusCode: 403,
  });
}
