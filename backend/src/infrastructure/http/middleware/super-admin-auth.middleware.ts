import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { RedisTokenDenylist } from "../../auth/TokenDenylist.js";

/**
 * Phase 4 — Super Admin auth middleware (frozen spec §2.1).
 *
 * Accepts either:
 *   1. A Super Admin JWT issued by `superAdminLoginUseCase`
 *      (role === "super_admin", not denylisted), OR
 *   2. The static `LICENSE_ADMIN_TOKEN` (backward-compatible with
 *      non-interactive scripts that haven't migrated to login yet).
 *
 * On success sets `req.systemAdmin = { id, email, role }`.
 */
export function createSuperAdminAuthMiddleware(
  jwtSigner: JwtSigner,
  denylist: RedisTokenDenylist,
  opts?: { fallbackToken?: string },
) {
  return async function superAdminAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "Admin authentication required", statusCode: 401 });
      return;
    }
    const provided = header.slice(7);

    // Backward-compatible static token fallback.
    if (opts?.fallbackToken && provided === opts.fallbackToken) {
      req.systemAdmin = { id: "static", email: "admin@system", role: "super_admin" };
      next();
      return;
    }

    try {
      const payload = await jwtSigner.verifyAccessToken(provided);
      if (payload.role !== "super_admin") {
        res.status(403).json({ code: "FORBIDDEN", message: "Super Admin only", statusCode: 403 });
        return;
      }
      if (await denylist.has(payload.jti)) {
        res
          .status(401)
          .json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة", statusCode: 401 });
        return;
      }
      req.systemAdmin = { id: payload.sub, email: payload.sub, role: payload.role };
      next();
    } catch {
      res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
    }
  };
}
