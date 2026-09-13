import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Revoked tokens — durable, DB-backed token denylist (P0-004).
 *
 * Why this table exists
 * ---------------------
 * Revocation used to live only in Redis. `DESKTOP_DEPLOY` runs the backend next
 * to a bundled PostgreSQL with **no Redis**, so `RedisTokenDenylist` silently
 * degraded to a no-op there: logout, admin revocation and device revocation all
 * left access and refresh tokens valid until their natural expiry. That is
 * exactly the "offline must work 100%" requirement this table satisfies — the
 * local database is always present, so revocation is always enforced.
 *
 * Redis, when configured (server deployments), stays in front of it as a fast
 * path; the table is the durable source of truth.
 *
 * Deliberately NOT RLS-managed
 * ----------------------------
 * Two reasons:
 *   1. It holds platform-level security bookkeeping only — a random `jti`, an
 *      expiry, and a reason. No tenant business data.
 *   2. It MUST be readable *before* a tenant context exists: the auth middleware
 *      checks every incoming bearer token, including on routes that resolve the
 *      tenant from the token itself. A tenant-scoped policy would make the row
 *      invisible on those checkouts and the revocation would silently fail.
 * It is therefore in the same exempt class as `schema_migrations` /
 * `__drizzle_migrations`, and both `rls-guard.test.ts` and `verify-rls.mjs`
 * list it as exempt.
 *
 * `subject` (the user id) and `tenantId` are informational today, but they are
 * what a future "revoke every session for this user" (force-logout) needs —
 * see P1-003b. Indexed so that query stays cheap.
 *
 * Units: `expiresAt` is an absolute timestamp, so the denylist is immune to the
 * milliseconds-vs-seconds confusion that the Redis path had (it used `setex`,
 * which takes seconds, while callers passed milliseconds — a ~82-year TTL
 * instead of the intended 30 days).
 */
export const revokedTokens = pgTable(
  "revoked_tokens",
  {
    jti: uuid("jti").primaryKey(),
    subject: uuid("subject"),
    tenantId: uuid("tenant_id"),
    reason: varchar("reason", { length: 40 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("idx_revoked_tokens_expires_at").on(table.expiresAt),
    subjectIdx: index("idx_revoked_tokens_subject").on(table.subject),
  }),
);
