-- Migration: harden RLS with NOBYPASSRLS, FORCE, and missing_ok (fix P0-SEC-4.1)
-- Idempotent: safe to rerun.

-- Create non-owner role that cannot bypass RLS
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN NOBYPASSRLS PASSWORD 'app_user_password_placeholder';
  ELSE
    ALTER ROLE app_user WITH NOBYPASSRLS;
  END IF;
END $$;

-- Grant CONNECT on whichever catalog this migration is running against.
-- GRANT ON DATABASE requires a literal identifier, so we quote
-- current_database() via format('%I') — server-derived, not user input,
-- no hardcoded catalog name (the previous fabric_erp literal aborted
-- migrate() on every database not named exactly that).
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Enable FORCE ROW LEVEL SECURITY so even table owners cannot bypass
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Fix policies to use missing_ok (current_setting(..., true)) so unset GUC returns NULL instead of error
-- Recreate tenant_isolation policies for all tenant tables
--
-- NULLIF guard (must match enable-rls.sql): `current_setting(..., true)` returns
-- NULL only while the GUC was never touched in the session. After
-- `set_config(guc, NULL)` or `RESET`, PG 17 returns '' (empty string), and
-- ''::uuid raises `invalid input syntax for type uuid`. Wrapping the value in
-- NULLIF(..., '') collapses both "unset" states to NULL, so an unscoped
-- connection matches no rows (safe isolation) instead of erroring out.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('users','parties','fabrics','colors','rolls','invoices','invoice_lines','orders','order_items','vouchers','ledger_entries','expenses','returns','return_lines','print_jobs','audit_logs','notifications','settings','document_sequences','stock_movements','idempotency_keys','party_balances','yearly_party_summaries','cashbox_sessions','day_closes','manual_movements')
  LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)', t);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;
