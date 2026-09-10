-- ============================================================================
-- rls_staging_probe.sql — يُثبت مصفوفة العزل على قاعدة staging معزولة هالكة
-- ============================================================================
\set ON_ERROR_STOP on

-- 0. تنظيف مسبق (DROP DATABASE لا يعمل داخل DO block)
DROP DATABASE IF EXISTS erp_rls_staging WITH (FORCE);
CREATE DATABASE erp_rls_staging;
\c erp_rls_staging

-- 1. جدول الصف (seed) كهيكل مبسّط مشابه للفئة 1
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  number text NOT NULL,
  UNIQUE (tenant_id, number)
);
CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  note text NOT NULL
);

INSERT INTO tenants VALUES
  ('00000000-0000-0000-0000-0000000000a1','Tenant A'),
  ('00000000-0000-0000-0000-0000000000b2','Tenant B');

INSERT INTO invoices VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','INV-A-1'),
  ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000b2','INV-B-1');

INSERT INTO invoice_lines VALUES
  ('11000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-0000000000a1','10000000-0000-0000-0000-000000000001','line A'),
  ('22000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-0000000000b2','20000000-0000-0000-0000-000000000002','line B');

-- 2. دور فحص يحاكي app_user (غير مالك، NOBYPASSRLS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rls_probe') THEN
    CREATE ROLE rls_probe WITH LOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO rls_probe;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_probe;

-- 3. تطبيق سياسة الفئة 1 على الجدولين
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_lines FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
