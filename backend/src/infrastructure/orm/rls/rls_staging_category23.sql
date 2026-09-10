-- ============================================================================
-- rls_staging_category23.sql — يثبت الفئة 2 (NULL غير مرئية) والفئة 3 (دليل)
-- ============================================================================
\set ON_ERROR_STOP off
\pset footer off
\pset pager off

-- الفئة 2: جدول يشبه licenses بشرط tenant_id NULLABLE
CREATE TABLE IF NOT EXISTS licenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NULL,
  key text NOT NULL
);
INSERT INTO licenses VALUES
  ('51000000-0000-0000-0000-000000000051', NULL, 'SYSTEM-NULL-LICENSE'),
  ('52000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-0000000000a1', 'A-LICENSE');

GRANT SELECT, INSERT, UPDATE, DELETE ON licenses TO rls_probe;

ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_or_tenant ON licenses;
CREATE POLICY platform_or_tenant ON licenses FOR ALL
  USING ( tenant_id = current_setting('app.current_tenant_id', true)::uuid
          OR current_setting('app.platform_mode', true) = 'on' )
  WITH CHECK ( tenant_id = current_setting('app.current_tenant_id', true)::uuid
          OR current_setting('app.platform_mode', true) = 'on' );

-- الفئة 3: tenants (الدليل) — الشركة ترى صفّها فقط
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_directory ON tenants;
CREATE POLICY tenant_directory ON tenants FOR ALL
  USING ( id = current_setting('app.current_tenant_id', true)::uuid
          OR current_setting('app.platform_mode', true) = 'on' )
  WITH CHECK ( id = current_setting('app.current_tenant_id', true)::uuid
          OR current_setting('app.platform_mode', true) = 'on' );

\echo '=== C2-1: GUC=A على licenses (نتوقع 1 = A فقط، صف NULL غير مرئي) ==='
SET app.current_tenant_id = '00000000-0000-0000-0000-0000000000a1';
SELECT count(*) AS cnt FROM licenses;

\echo '=== C2-2: GUC=A + platform_mode=on (نتوقع 2 = A + NULL) ==='
SET app.platform_mode = 'on';
SELECT count(*) AS cnt FROM licenses;

\echo '=== C2-3: بلا GUC ولا platform (نتوقع 0) ==='
RESET app.current_tenant_id;
RESET app.platform_mode;
SELECT count(*) AS cnt FROM licenses;

\echo '=== C3-1: GUC=A على tenants (نتوقع 1 = صفّك فقط) ==='
SET app.current_tenant_id = '00000000-0000-0000-0000-0000000000a1';
SELECT count(*) AS cnt FROM tenants;

\echo '=== C3-2: platform_mode=on على tenants (نتوقع 2 = الكل) ==='
SET app.platform_mode = 'on';
SELECT count(*) AS cnt FROM tenants;
