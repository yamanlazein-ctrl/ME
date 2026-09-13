import type { Request, Response, NextFunction } from "express";
import { canWriteOffline } from "../../../domain/sync/offlineWritePolicy.js";
import { isServerSideOffline } from "../../../application/use-cases/sync/hubConfig.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Warehouse/viewer may not write while the hub is unreachable, or when the
 * client reports offline. Admin/accountant keep local-first writes.
 */
export function offlineWriteGuard(req: Request, res: Response, next: NextFunction): void {
  const clientOffline = req.headers["x-offline-mode"] === "1";
  const hubOffline = isServerSideOffline();
  if (!clientOffline && !hubOffline) {
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
