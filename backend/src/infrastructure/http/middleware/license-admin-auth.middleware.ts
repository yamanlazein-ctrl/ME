import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

/**
 * Phase 0 sub-batch 0J — license admin auth middleware.
 *
 * Separate auth realm from the user JWT. The admin client must send
 * `Authorization: Bearer <LICENSE_ADMIN_TOKEN>`. The token is
 * compared in constant time to avoid timing attacks.
 */
export function createLicenseAdminAuthMiddleware(expectedToken: string) {
  return function licenseAdminAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "Admin token required", statusCode: 401 });
      return;
    }
    const provided = header.slice(7);
    const a = Buffer.from(provided);
    const b = Buffer.from(expectedToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "Invalid admin token", statusCode: 401 });
      return;
    }
    next();
  };
}
