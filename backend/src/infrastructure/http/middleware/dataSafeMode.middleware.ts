import type { RequestHandler } from "express";
import { isDataSafeMode } from "../../integrity/dataIntegrityManifest.js";

/**
 * REPAIR-023: when SAFE_MODE is active, mutating methods return 503.
 * Read routes continue to work for diagnostics.
 */
export function dataSafeModeGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isDataSafeMode()) return next();
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    // SAFE_MODE must still permit authentication and the authenticated,
    // audited integrity control plane; all business mutations remain blocked.
    const path = req.path;
    if (
      path.startsWith("/api/integrity") ||
      path.startsWith("/integrity") ||
      path === "/api/auth/login" ||
      path === "/api/auth/pin-login" ||
      path === "/api/auth/refresh" ||
      path === "/api/auth/logout"
    ) {
      return next();
    }
    res.status(503).json({
      code: "DATA_SAFE_MODE",
      message: "النظام في وضع الأمان — تم اكتشاف انخفاض حاد في البيانات. القراءة فقط حتى تُقبل الحالة أو تُستعاد نسخة احتياطية.",
      statusCode: 503,
    });
  };
}
