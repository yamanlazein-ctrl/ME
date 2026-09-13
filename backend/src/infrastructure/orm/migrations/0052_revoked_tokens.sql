-- 0052: DB-backed token revocation (P0-004).
--
-- DESKTOP_DEPLOY runs the backend next to a bundled PostgreSQL and has no Redis,
-- so the Redis-only denylist degraded to a silent no-op there: logout, admin
-- revocation and device revocation left access/refresh tokens valid until their
-- natural expiry. This table makes revocation durable and offline-capable.
-- Redis, when present (server deployments), stays in front as a fast path.
--
-- Deliberately NOT RLS-managed: it is platform-level security bookkeeping
-- (random jti + expiry + reason, no tenant business data) and it MUST be
-- readable before a tenant context exists — the auth middleware checks every
-- bearer token on every request, including on routes that resolve the tenant
-- from the token itself. Same exempt class as schema_migrations /
-- __drizzle_migrations; both rls-guard.test.ts and verify-rls.mjs list it.
--
-- `expires_at` is an absolute timestamp, which also removes the
-- milliseconds-vs-seconds ambiguity the Redis path had (setex takes seconds,
-- callers passed milliseconds -> ~82 years instead of 30 days).
--
-- Idempotent: safe to rerun.

CREATE TABLE IF NOT EXISTS "revoked_tokens" (
  "jti" uuid PRIMARY KEY,
  "subject" uuid,
  "tenant_id" uuid,
  "reason" varchar(40) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_revoked_tokens_expires_at" ON "revoked_tokens" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_revoked_tokens_subject" ON "revoked_tokens" ("subject");
