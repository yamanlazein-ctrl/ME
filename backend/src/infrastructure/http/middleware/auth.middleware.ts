import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { RedisTokenDenylist } from "../../auth/TokenDenylist.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { db } from "../../orm/drizzle.js";
import { users } from "../../orm/schemas/user.table.js";
import { eq } from "drizzle-orm";

// Invoice-tracking / audit feature: audit rows store the ACTOR's display name,
// so the auth context must carry the real user name (not the raw JWT subject).
// Small in-memory cache keeps the per-request lookup off the hot path.
const userNameCache = new Map<string, { name: string; expiresAt: number }>();
const NAME_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveUserName(userId: string, fallback: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const name = row?.name || fallback;
    userNameCache.set(userId, { name, expiresAt: Date.now() + NAME_CACHE_TTL_MS });
    return name;
  } catch {
    return fallback;
  }
}

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
        userName: await resolveUserName(payload.sub, payload.sub),
      };

      next();
    } catch {
      res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
    }
  };
}
