import type { Request, Response, NextFunction } from "express";
import type { JwtSigner } from "../../auth/JwtSigner.js";
import type { TokenDenylist } from "../../auth/TokenDenylist.js";
import type { Role, TenantContext } from "../../../domain/types/index.js";
import { db } from "../../orm/drizzle.js";
import { runWithTenantContext } from "../../orm/tenant-context.js";
import { users } from "../../orm/schemas/user.table.js";
import { eq } from "drizzle-orm";
import { logger } from "../../config/logger.js";

/**
 * Session identity cache.
 *
 * The audit trail stores the ACTOR's display name, so the context needs the
 * real user name — and Batch 4 (4B "revoked user", "forged actor role") also
 * needs the user's CURRENT `active` flag and `role`. All three come from one
 * lookup, cached briefly.
 *
 * Why the DB value and not the token claim: a signed token is only a snapshot.
 * Without re-reading the row, a user demoted from `admin` kept admin authority
 * for the whole access-token lifetime, and a deactivated user kept working
 * until their token expired (only `/api/auth/me` and `/api/auth/refresh`
 * noticed `active=false`). Role and active state are therefore authoritative
 * from the DB, refreshed every minute.
 */
const identityCache = new Map<
  string,
  { name: string; role: Role | null; active: boolean; expiresAt: number }
>();
const IDENTITY_CACHE_TTL_MS = 60 * 1000;

type Identity = { name: string; role: Role | null; active: boolean; known: boolean };

async function resolveIdentity(userId: string, fallback: string): Promise<Identity> {
  const cached = identityCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { name: cached.name, role: cached.role, active: cached.active, known: true };
  }
  const [row] = await db
    .select({ name: users.name, role: users.role, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return { name: fallback, role: null, active: false, known: false };
  const identity: Identity = {
    name: row.name || fallback,
    role: row.role as Role,
    active: row.active,
    known: true,
  };
  identityCache.set(userId, {
    name: identity.name,
    role: identity.role,
    active: identity.active,
    expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
  });
  return identity;
}

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

      // Batch 4 / 4B: the tenant realm only serves tenant users. A token whose
      // tenant is not a UUID belongs to another realm (super-admin mints the
      // "system" sentinel) and must never reach tenant routes — `/api/auth/me`
      // and `/api/auth/refresh` already refuse it, and this closes the same gap
      // on every other route.
      if (!isUuid(payload.tenantId)) {
        res.status(401).json({ code: "UNAUTHORIZED", message: "جلسة غير صالحة", statusCode: 401 });
        return;
      }

      // Establish the request-scoped tenant context BEFORE any business query
      // (including the `users` lookup below) runs. This stamps the RLS
      // GUC on every connection this request checks out — resolving the
      // شرط-1 ordering problem: the tenant id comes from the already-verified
      // JWT, never from a circular DB read.
      return runWithTenantContext({ tenantId: payload.tenantId }, async () => {
        // Revoked user (4B): a deactivated/deleted user's session must stop
        // working immediately, not when their token happens to expire. A
        // missing row is the same verdict — `/me` already 401s on it.
        let identity: Identity | null = null;
        try {
          identity = await resolveIdentity(payload.sub, payload.sub);
        } catch (err) {
          // Database unavailable: the request has no authority to gain from
          // this check (every business route needs the DB anyway), so keep the
          // pre-existing behaviour — token claims stand — and say so loudly.
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
          // DB role wins over the token claim: a role change takes effect on
          // the next request (within the identity cache TTL) instead of
          // surviving in an old token — the "forged actor role" gap.
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
