-- ============================================================================
-- 20260914_sync_rls_canonical_policies.sql
-- Batch 2: bring `sync_tombstones` and `sync_conflicts` into the canonical
-- tenant-isolation policy layer (enable-rls.sql §1).
--
-- WHY (observed live, PG 17.10):
--   0058_sync_tombstones.sql and 20260912_batch1_tombstones_conflicts.sql
--   created their policies by hand with the UNGUARDED cast
--   `tenant_id = current_setting('app.current_tenant_id', true)::uuid`:
--
--     (a) set_config('app.current_tenant_id', NULL, false) — which the
--         TenantScopedPool issues on EVERY checkout with no tenant context —
--         stores the EMPTY STRING, not NULL, so current_setting(...) returns
--         '' and ''::uuid raises 22P02 "invalid input syntax for type uuid".
--         Verified live: `select count(*) from sync_tombstones` errored with
--         22P02 on a no-tenant checkout, instead of returning zero rows.
--         The tombstone lookup swallows its errors and returns "no tombstone",
--         so a failed lookup degrades into a MISSED resurrection guard. This is
--         exactly the hazard enable-rls.sql §"المعنى الحاسم" already documents
--         and guards with NULLIF.
--
--     (b) The hand-written policy also escaped to platform mode
--         (`OR current_setting('app.platform_mode', true) = 'on'`), which the
--         canonical layer deliberately does NOT grant to tenant-scoped sync
--         tables — every other sync table is strict tenant_isolation. Deletes
--         and conflict records are business data, not platform rows.
--
--     (c) `sync_conflicts` was ENABLEd but never FORCEd, unlike every other
--         sync table, so a table owner connection silently bypassed isolation.
--
-- This migration is idempotent and additive: it only rewrites the two
-- policies and (re)asserts ENABLE + FORCE. The canonical expression matches
-- enable-rls.sql §1 exactly, so applying either one converges to the same
-- policy. It never deletes rows and never touches business data.
-- ============================================================================

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['sync_tombstones', 'sync_conflicts'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      -- Drop the legacy hand-written policy (named after the table) plus any
      -- previous canonical policy, then create exactly one canonical policy.
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL '
        'USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) '
        'WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
