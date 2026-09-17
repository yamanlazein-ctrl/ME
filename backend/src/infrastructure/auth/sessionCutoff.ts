import { and, eq } from "drizzle-orm";
import { db } from "../orm/drizzle.js";
import { users } from "../orm/schemas/user.table.js";
import type { Role } from "../../domain/types/index.js";

/**
 * Per-subject session cutoff. Tokens whose `iat` is strictly before this
 * timestamp are refused, even if their jti is not in `revoked_tokens`.
 * Other users are untouched.
 */
export const SESSION_REVOKED_BODY = {
  code: "SESSION_REVOKED" as const,
  message: "أُلغيت جلسات هذا المستخدم — سجّل الدخول من جديد",
};

export function isTokenBeforeCutoff(
  iatSeconds: number | undefined,
  cutoff: Date | null | undefined,
): boolean {
  if (!cutoff || iatSeconds == null || !Number.isFinite(iatSeconds)) return false;
  return iatSeconds * 1000 < cutoff.getTime();
}

export async function revokeSubjectSessions(userId: string, tenantId: string): Promise<Date> {
  const cutoff = new Date();
  await db
    .update(users)
    .set({ tokensRevokedBefore: cutoff, updatedAt: cutoff })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
  invalidateIdentityCache(userId);
  return cutoff;
}

type CachedIdentity = {
  name: string;
  role: Role | null;
  active: boolean;
  tokensRevokedBefore: Date | null;
  expiresAt: number;
};

const identityCache = new Map<string, CachedIdentity>();
const IDENTITY_CACHE_TTL_MS = 60 * 1000;

export function invalidateIdentityCache(userId?: string): void {
  if (userId) identityCache.delete(userId);
  else identityCache.clear();
}

export type SessionIdentity = {
  name: string;
  role: Role | null;
  active: boolean;
  tokensRevokedBefore: Date | null;
  known: boolean;
};

export async function resolveSessionIdentity(
  userId: string,
  fallback: string,
): Promise<SessionIdentity> {
  const cached = identityCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      name: cached.name,
      role: cached.role,
      active: cached.active,
      tokensRevokedBefore: cached.tokensRevokedBefore,
      known: true,
    };
  }
  const [row] = await db
    .select({
      name: users.name,
      role: users.role,
      active: users.active,
      tokensRevokedBefore: users.tokensRevokedBefore,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    return {
      name: fallback,
      role: null,
      active: false,
      tokensRevokedBefore: null,
      known: false,
    };
  }
  const identity: SessionIdentity = {
    name: row.name || fallback,
    role: row.role as Role,
    active: row.active,
    tokensRevokedBefore: row.tokensRevokedBefore ?? null,
    known: true,
  };
  identityCache.set(userId, {
    name: identity.name,
    role: identity.role,
    active: identity.active,
    tokensRevokedBefore: identity.tokensRevokedBefore,
    expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
  });
  return identity;
}
