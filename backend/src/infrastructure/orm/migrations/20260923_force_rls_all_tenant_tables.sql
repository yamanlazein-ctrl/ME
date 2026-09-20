-- DFP-018: migration-time invariant — every public table with a tenant_id
-- column MUST have RLS enabled and FORCED (including tables added after 0029).
-- Idempotent. Does not alter policies; only ENABLE + FORCE.
--
-- EXCLUSION (P0 security regression, fixed in 20260927): a table whose
-- `tenant_id` is nullable and which is read BEFORE a tenant context exists
-- must not be swept up here. FORCE RLS with no matching policy returns zero
-- rows even to the owner. `revoked_tokens` is checked by the auth middleware
-- while the tenant is still being resolved FROM the token, so forcing RLS on
-- it made every revoked JWT read as valid.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> 'revoked_tokens'
      AND EXISTS (
        SELECT 1
        FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
