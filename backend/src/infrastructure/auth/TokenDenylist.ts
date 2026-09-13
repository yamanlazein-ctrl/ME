import { Redis } from "ioredis";
import { and, eq, gt, lt } from "drizzle-orm";
import { config } from "../config/env.js";
import { db } from "../orm/drizzle.js";
import { revokedTokens } from "../orm/schemas/revoked-token.table.js";

/**
 * Token denylist (P0-004).
 *
 * Before: revocation lived ONLY in Redis. `DESKTOP_DEPLOY` runs the backend
 * next to a bundled PostgreSQL with no Redis, so every method here was a silent
 * no-op — logout, admin revocation and device revocation left access/refresh
 * tokens valid until their natural expiry.
 *
 * Now: the PostgreSQL table `revoked_tokens` is the durable source of truth and
 * is always present (desktop ships its own database), so revocation is enforced
 * offline. Redis, when configured, sits in front as a fast path — it is an
 * optimisation, never a requirement.
 *
 * Unit contract: **ttlSeconds**, everywhere. The Redis implementation uses
 * `setex`, which takes seconds; callers used to pass milliseconds, which turned
 * the intended 30-day licence revocation into ~82 years. The DB implementation
 * stores an absolute `expires_at`, so it cannot drift with the unit at all.
 */

export const redis = config.REDIS_URL ? new Redis(config.REDIS_URL) : null;

export async function checkRedis(): Promise<boolean> {
  if (!redis) return false;
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

/** Why a jti was revoked — recorded for audit and for future force-logout. */
export type RevocationReason =
  | "logout"
  | "rotated"
  | "reuse-detected"
  | "license-deactivated"
  | "admin-revoke"
  | "device-revoke";

export interface RevocationMeta {
  reason?: RevocationReason;
  /** User id the token belonged to (enables "revoke all sessions" later). */
  subject?: string;
  tenantId?: string;
}

export interface TokenDenylist {
  /** `ttlSeconds` is how long the revocation must outlive the token. */
  add(jti: string, ttlSeconds: number, meta?: RevocationMeta): Promise<void>;
  has(jti: string): Promise<boolean>;
  delete(jti: string): Promise<void>;
}

/** Redis-backed denylist. Fast path; never the source of truth on its own. */
export class RedisTokenDenylist implements TokenDenylist {
  constructor(private readonly redis: Redis | null) {}

  async add(jti: string, ttlSeconds: number): Promise<void> {
    if (!this.redis) return;
    await this.redis.setex(`denylist:${jti}`, Math.max(1, Math.ceil(ttlSeconds)), "1");
  }

  async has(jti: string): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.get(`denylist:${jti}`);
    return result === "1";
  }

  async delete(jti: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(`denylist:${jti}`);
  }
}

/**
 * PostgreSQL-backed denylist. Always available — this is what makes revocation
 * work on a machine with no Redis.
 *
 * Failure policy: a database error while checking `has()` is logged and treated
 * as "not revoked" (fail-open). That is deliberate and not equivalent to the old
 * silent no-op: every request still needs the database for its own queries, so a
 * failing database cannot let an attacker through — it fails the request anyway.
 * Failing closed here would turn a transient hiccup into a total auth outage.
 */
export class DbTokenDenylist implements TokenDenylist {
  /** Probabilistic sweep of expired rows (1 in 100 writes). */
  private static readonly SWEEP_ODDS = 100;

  async add(jti: string, ttlSeconds: number, meta?: RevocationMeta): Promise<void> {
    if (!jti || ttlSeconds <= 0) return;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await db
      .insert(revokedTokens)
      .values({
        jti,
        subject: meta?.subject ?? null,
        tenantId: meta?.tenantId ?? null,
        reason: meta?.reason ?? "logout",
        expiresAt,
      })
      .onConflictDoUpdate({
        target: revokedTokens.jti,
        set: { expiresAt, reason: meta?.reason ?? "logout" },
      });

    if (Math.floor(Math.random() * DbTokenDenylist.SWEEP_ODDS) === 0) {
      await this.sweepExpired().catch(() => {});
    }
  }

  async has(jti: string): Promise<boolean> {
    if (!jti) return false;
    try {
      const rows = await db
        .select({ jti: revokedTokens.jti })
        .from(revokedTokens)
        .where(and(eq(revokedTokens.jti, jti), gt(revokedTokens.expiresAt, new Date())))
        .limit(1);
      return rows.length > 0;
    } catch (err) {
      // A non-UUID jti would make Postgres reject the cast; anything else is a
      // real database error. Either way we cannot claim the token is revoked.
      console.error("[denylist] has() failed, treating token as not revoked:", err);
      return false;
    }
  }

  async delete(jti: string): Promise<void> {
    if (!jti) return;
    await db.delete(revokedTokens).where(eq(revokedTokens.jti, jti));
  }

  /** Drop rows whose tokens have already expired — they can never be replayed. */
  async sweepExpired(): Promise<number> {
    const deleted = await db
      .delete(revokedTokens)
      .where(lt(revokedTokens.expiresAt, new Date()))
      .returning({ jti: revokedTokens.jti });
    return deleted.length;
  }

  /**
   * How many live revocations belong to one user. `subject` is only recorded for
   * tokens we actively revoked — this table cannot enumerate the tokens a user
   * currently holds, so it is NOT by itself a "force-logout" primitive. A real
   * force-logout needs a per-subject cutoff compared against the token's `iat`
   * (P1-003b); the `subject` index exists so that query stays cheap when it
   * lands. Deliberately not exposed as `revokeSubject()`, which would imply it
   * revokes tokens it never sees.
   */
  async countRevokedForSubject(subject: string): Promise<number> {
    const rows = await db
      .select({ jti: revokedTokens.jti })
      .from(revokedTokens)
      .where(and(eq(revokedTokens.subject, subject), gt(revokedTokens.expiresAt, new Date())));
    return rows.length;
  }
}

/**
 * Durable DB denylist + optional Redis fast path.
 *
 * `add` writes both (Redis failures are swallowed — the DB write is what makes
 * the revocation real). `has` consults Redis first and always falls back to the
 * database, so an entry written while Redis was unavailable is still found.
 */
export class CompositeTokenDenylist implements TokenDenylist {
  constructor(
    private readonly durable: TokenDenylist,
    private readonly fast: TokenDenylist | null,
  ) {}

  async add(jti: string, ttlSeconds: number, meta?: RevocationMeta): Promise<void> {
    await this.durable.add(jti, ttlSeconds, meta);
    if (this.fast) {
      await this.fast.add(jti, ttlSeconds, meta).catch((err) => {
        console.warn("[denylist] Redis fast path add failed (durable write already done):", err);
      });
    }
  }

  async has(jti: string): Promise<boolean> {
    if (this.fast) {
      try {
        if (await this.fast.has(jti)) return true;
      } catch (err) {
        console.warn("[denylist] Redis fast path has() failed, falling back to DB:", err);
      }
    }
    return this.durable.has(jti);
  }

  async delete(jti: string): Promise<void> {
    await this.durable.delete(jti);
    if (this.fast) await this.fast.delete(jti).catch(() => {});
  }
}
