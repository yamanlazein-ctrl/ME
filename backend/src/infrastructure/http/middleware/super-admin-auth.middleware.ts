import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { TokenDenylist } from "../../auth/TokenDenylist.js";

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
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

/**
 * ERP-005: the open-loopback console is for a caller ON this machine. A local reverse proxy (the
 * admin-dashboard Vite dev server) also connects from loopback, so the socket alone proves nothing:
 * every forwarded hop must be loopback too. The socket is checked, never `req.ip` alone (`req.ip`
 * comes from X-Forwarded-For when `trust proxy` is set, i.e. it is caller-supplied).
 */
function isLocalCaller(req: Request): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const xff = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(xff) ? xff.join(",") : (xff ?? ""))
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.some((h) => !isLoopbackAddress(h))) return false;
  const forwarded = req.headers.forwarded;
  if (forwarded) {
    const fors = [...String(forwarded).matchAll(/for="?\[?([^\]";,\s]+)/gi)].map((m) => m[1]);
    if (fors.some((h) => !isLoopbackAddress(h))) return false;
  }
  return true;
}

export function createSuperAdminAuthMiddleware(
  jwtSigner: JwtSigner,
  denylist: TokenDenylist,
  opts?: { fallbackToken?: string; openLoopback?: boolean },
) {
  return async function superAdminAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Owner-only local license console: when enabled, loopback callers need no
    // email/password. Remote clients still require JWT / static token.
    if (opts?.openLoopback && isLocalCaller(req)) {
      req.systemAdmin = { id: "local-loopback", email: "local@loopback", role: "super_admin" };
      next();
      return;
    }

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
