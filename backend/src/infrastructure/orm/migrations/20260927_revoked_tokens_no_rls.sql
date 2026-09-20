-- P0 SECURITY: restore readability of the JWT revocation denylist.
--
-- 20260923_force_rls_all_tenant_tables blanket-enabled and FORCED row-level
-- security on every public table carrying a `tenant_id` column. `revoked_tokens`
-- has a nullable `tenant_id` (a revocation is not tenant-scoped work), so it was
-- swept up — but it has NO policy, and FORCE RLS applies even to the table
-- owner. The result: `SELECT ... FROM revoked_tokens` returned ZERO rows for
-- the application role, so `isRevoked(jti)` always answered "not revoked".
--
-- Impact: logout, forced session revocation and the token cutoff silently
-- stopped working — a revoked JWT stayed valid until natural expiry.
--
-- Why NOT RLS is correct here: the auth middleware checks every bearer token
-- BEFORE a tenant context exists (the tenant is resolved FROM the token). A
-- tenant-scoped policy can never match on those checkouts, so the denylist
-- must be readable independently of `app.current_tenant_id`. The table holds
-- no business data — only opaque jti/subject identifiers and an expiry.
ALTER TABLE "revoked_tokens" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "revoked_tokens" DISABLE ROW LEVEL SECURITY;
