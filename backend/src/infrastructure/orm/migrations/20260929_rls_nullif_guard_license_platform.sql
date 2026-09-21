-- ============================================================================
-- 20260929_rls_nullif_guard_license_platform.sql
--
-- Batch 3 of the canonical RLS hardening (follows
-- 20260914_sync_rls_canonical_policies.sql, which fixed sync_tombstones and
-- sync_conflicts): converge the remaining pre-canonical policies onto the
-- exact expressions defined in rls/enable-rls.sql (the approved D4 layer).
--
-- WHY (observed live, PG 17, fresh erp_acceptance provision):
--   TenantScopedPool issues set_config('app.current_tenant_id', NULL, false)
--   on EVERY checkout with no tenant context. PostgreSQL stores that as the
--   EMPTY STRING, not NULL, so current_setting('app.current_tenant_id', true)
--   returns '' and the unguarded ''::uuid cast raises 22P02
--   "invalid input syntax for type uuid". Verified live:
--     * GET /license-admin/licenses       -> 500 (SELECT FROM licenses)
--     * GET /api/setup/status             -> 503 (SELECT FROM setup_wizard_state)
--     * startup detachOrphanBakedLicenses -> 22P02 (SELECT licenses ⨝ tenants)
--   A fresh install therefore cannot list licenses or read setup state at
--   all. enable-rls.sql §"المعنى الحاسم" documents exactly this and mandates
--   NULLIF(current_setting(..., true), '')::uuid everywhere.
--
-- WHAT CHANGES (per-table semantics now match enable-rls.sql exactly):
--   * Category 2 (platform-managed): licenses, secrets, server_installations,
--     license_audit_events, license_activations, device_registrations,
--     setup_wizard_state, invitation_codes get the canonical
--     `platform_or_tenant` policy:
--       tenant match OR current_setting('app.platform_mode', true) = 'on'
--     This replaces the 0002-era "tenant_id IS NULL is visible to everyone"
--     policy — which both crashed on no-tenant checkouts (22P02) AND leaked
--     system-level NULL rows (e.g. secrets) to every tenant. Platform code
--     paths (license server global middleware, setup/bootstrap use cases) run
--     under runWithPlatformContext and keep full access.
--   * Category 1 (tenant-scoped): company_profiles, attachments,
--     ledger_entry_archive get the canonical strict NULLIF-guarded
--     `tenant_isolation` policy (USING + WITH CHECK).
--   * yearly_party_summaries: the legacy duplicate policy
--     `tenant_isolation_yearly_summary` (unguarded, no missing_ok) is DROPPED;
--     the canonical guarded `tenant_isolation` policy already covers the
--     table (both permissive/ALL, so the duplicate added nothing but crashes).
--   * The text-comparison sync policies (sync_devices, sync_outbox,
--     sync_inbox, sync_resource_claims, sync_state, document_number_blocks)
--     compare tenant_id::text and never cast to uuid, so they cannot raise
--     22P02; they are intentionally NOT touched here.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY. Never deletes rows,
-- never touches business data.
-- ============================================================================

DO $$
DECLARE
  -- Category 2 — platform-managed (tenant match OR explicit platform mode)
  platform_tables text[] := ARRAY[
    'licenses',
    'secrets',
    'server_installations',
    'license_audit_events',
    'license_activations',
    'device_registrations',
    'setup_wizard_state',
    'invitation_codes'
  ];
  -- Category 1 — strict tenant-scoped
  strict_tables text[] := ARRAY[
    'company_profiles',
    'attachments',
    'ledger_entry_archive'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY platform_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      -- Drop every legacy pre-canonical policy on the table (permissive
      -- policies OR together, so any left-over unguarded policy would keep
      -- both the crash and the NULL-row leak alive).
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format('DROP POLICY IF EXISTS platform_or_tenant ON %I', t);
      EXECUTE format(
        'CREATE POLICY platform_or_tenant ON %I FOR ALL '
        'USING ('
        '  tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid '
        '  OR current_setting(''app.platform_mode'', true) = ''on'' '
        ') '
        'WITH CHECK ('
        '  tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid '
        '  OR current_setting(''app.platform_mode'', true) = ''on'' '
        ')',
        t
      );
    END IF;
  END LOOP;

  FOREACH t IN ARRAY strict_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      -- legacy alias used by 0020 for the archive table
      IF t = 'ledger_entry_archive' THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation_ledger_archive', t);
      END IF;
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL '
        'USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) '
        'WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
        t
      );
    END IF;
  END LOOP;

  -- yearly_party_summaries: drop the legacy unguarded duplicate; the canonical
  -- guarded `tenant_isolation` policy already covers the table.
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'yearly_party_summaries') THEN
    DROP POLICY IF EXISTS tenant_isolation_yearly_summary ON yearly_party_summaries;
  END IF;
END $$;
