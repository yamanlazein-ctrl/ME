import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { TokenDenylist } from "../../auth/TokenDenylist.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { runWithTenantContext } from "../../orm/tenant-context.js";
import { logger } from "../../config/logger.js";
import {
  isTokenBeforeCutoff,
  resolveSessionIdentity,
  SESSION_REVOKED_BODY,
  type SessionIdentity,
} from "../../auth/sessionCutoff.js";

export function createAuthMiddleware(jwtSigner: JwtSigner, tokenDenylist: TokenDenylist) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول", statusCode: 401 });
      return;
    }

    const token = header.slice(7);
    try {
      const payload = await jwtSigner.verifyAccessToken(token);

      if (await tokenDenylist.has(payload.jti)) {
        res
          .status(401)
          .json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة", statusCode: 401 });
        return;
      }

      if (!isUuid(payload.tenantId)) {
        res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
        return;
      }

      return runWithTenantContext({ tenantId: payload.tenantId }, async () => {
        let identity: SessionIdentity | null = null;
        try {
          identity = await resolveSessionIdentity(payload.sub, payload.sub);
        } catch (err) {
          logger.warn({ err, userId: payload.sub }, "auth identity lookup failed (DB error)");
        }

        if (identity && (!identity.known || !identity.active)) {
          logger.warn(
            { userId: payload.sub, tenantId: payload.tenantId, path: req.path },
            "refused session for inactive/unknown user",
          );
          res.status(401).json({
            code: "TOKEN_EXPIRED",
            message: "انتهت صلاحية الجلسة",
            statusCode: 401,
          });
          return;
        }

        if (identity && isTokenBeforeCutoff(payload.iat, identity.tokensRevokedBefore)) {
          res.status(401).json({
            ...SESSION_REVOKED_BODY,
            statusCode: 401,
          });
          return;
        }

        const deviceHeader = req.headers["x-sync-device-id"];
        const syncDeviceId =
          typeof deviceHeader === "string"
            ? deviceHeader
            : Array.isArray(deviceHeader)
              ? deviceHeader[0]
              : null;

        req.tenantContext = {
          tenantId: payload.tenantId,
          userId: payload.sub,
          userRole: (identity?.role ?? payload.role) as TenantContext["userRole"],
          userName: identity?.name ?? payload.sub,
          syncDeviceId: syncDeviceId && isUuid(syncDeviceId) ? syncDeviceId : null,
        };

        next();
      });
    } catch {
      res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
    }
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
