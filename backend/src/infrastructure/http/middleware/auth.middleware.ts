import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { RedisTokenDenylist } from "../../auth/TokenDenylist.js";
import type { TenantContext } from "../../../domain/types/index.js";

export function createAuthMiddleware(jwtSigner: JwtSigner, tokenDenylist: RedisTokenDenylist) {
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

      req.tenantContext = {
        tenantId: payload.tenantId,
        userId: payload.sub,
        userRole: payload.role as TenantContext["userRole"],
        userName: payload.sub,
      };

      next();
    } catch {
      res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
    }
  };
}
