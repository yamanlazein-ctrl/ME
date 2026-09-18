-- ============================================================================
-- enable-rls.sql — تفعيل عزل الشركات (Row-Level Security) على PostgreSQL
-- نسخة مصحّحة ومعتمَدة (تحل محل 0029_rls_hardening.sql الناقص).
--
-- التصنيف المعتمَد (D4): ثلاث فئات منفصلة، بلا سياسة عامة "NULL OR tenant".
--   الفئة 1: tenant-scoped   (tenant_id NOT NULL)  — بيانات الأعمال
--   الفئة 2: platform-owned  (tenant_id NULLABLE)  — صفوف NULL = ملكية نظام
--   الفئة 3: global          (بلا عمود tenant_id)  — دليل المنصة
--
-- آلية "سياق المنصة": GUC صريح `app.platform_mode` يُضبط فقط من مسارات
-- platform معتمدة (License Server / bootstrap)، وليس `tenant_id IS NULL`.
-- بهذا لا تصبح صفوف NULL مرئية تلقائياً لأي شركة.
--
-- المعنى الحاسم لـ current_setting(..., true):
--   عدم ضبط GUC -> NULL -> لا يطابق أي صف -> عزل كامل بدل خطأ/تسريب.
--   ملاحظة مثبتة حياً (PG 17.10): بعد set_config(guc, NULL) أو RESET يعود
--   current_setting بقيمة '' (سلسلة فارغة) وليس NULL — و''::uuid يرمي خطأ.
--   لذا كل casts على uuid تُغلَّف بـ NULLIF(..., '') لتقبل الحالتين معاً.
--
-- Idempotent: آمن لإعادة التشغيل.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. دور التطبيق (غير مالك) — يطبَّق عليه RLS تلقائياً + NOBYPASSRLS
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE app_user WITH NOBYPASSRLS;
  END IF;
END $$;

-- ملاحظة: مالك الجداول الحالي هو `postgres`، ودور الاتصال وقت التشغيل هو
-- `app_user` (غير مالك، NOBYPASSRLS) — لذا تُطبَّق سياسات RLS عليه تلقائياً
-- حتى بدون FORCE. FORCE يقيّد المالك أيضاً (انظر القسم 4).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. الفئة 1 — tenant-scoped (tenant_id NOT NULL)
--    سياسة صارمة: صفوفي فقط.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'attachments','audit_logs','cashbox_sessions','colors','company_profiles',
    'day_closes','document_sequences','expenses',
    'fabrics','idempotency_keys','invoice_lines','invoices',
    'ledger_entries','ledger_entry_archive',
    'manual_movements','notifications','order_items','orders','parties',
    'party_balances','print_jobs','return_lines','returns','rolls','settings',
    'stock_movements','users','vouchers',
    'yearly_party_summaries',
    -- Sync engine (0047-0051). All six carry a NOT NULL tenant_id, so they
    -- belong to the tenant-scoped family. They are listed here — and not only
    -- in their own migration — because this file is the canonical policy
    -- layer: rls-guard.test.ts asserts every TS business table appears here,
    -- and verify-rls.mjs counts the tenant_isolation family at runtime.
    'sync_devices','sync_outbox','sync_inbox',
    'sync_resource_claims','sync_state','sync_device_authorized_users',
    'document_number_blocks',
    -- Tombstones (0058) and the conflict ledger (batch1) are tenant-scoped
    -- business data too: a recorded delete, and the losing side of a
    -- concurrent edit, must be invisible to every other company. They were
    -- created with a hand-written `::uuid` cast — which raises 22P02 once
    -- set_config(..., NULL) has stored '' — plus an unnecessary platform
    -- escape; listing them here keeps them on the canonical NULLIF-guarded
    -- expression. Migration 20260914_sync_rls_canonical_policies applies the
    -- same rewrite on databases that only run `db:migrate`.
    'sync_tombstones','sync_conflicts'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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

-- ────────────────────────────────────────────────────────────────────────────
-- 2. الفئة 2 — platform-managed (رؤية: شركة خاصة بها OR سياق platform).
--    صفوف tenant_id = NULL مُلكية نظام: تُقرأ/تُكتب فقط بسياق platform صريح،
--    وليست مرئية لأي شركة (لا "NULL OR tenant" عامة).
--    تتضمن أيضاً جداول تُدار عبر المنصة لكنها معرّفة لكل شركة
--    (license_activations / device_registrations / setup_wizard_state /
--    invitation_codes): كود License Server ومعالج الإعداد واستهلاك الدعوات
--    يقرأها/يكتبها عبر عدة شركات بسياق platform (مسارات ما قبل JWT)، بينما
--    ترى كل شركة صفوفها فقط — لهذا تحتاج نفس سياسة "شركة OR platform".
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'licenses','secrets','server_installations','license_audit_events',
    'license_activations','device_registrations','setup_wizard_state',
    'invitation_codes'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. الفئة 3 — global (بلا عمود tenant_id)
--    tenants: الشركة ترى صفّها فقط; platform يرى الكل (دليل).
--    system_admins: platform فقط، لا شركة نهائياً.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='tenants') THEN
    ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_directory ON tenants;
    CREATE POLICY tenant_directory ON tenants FOR ALL
      USING (
        id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        OR current_setting('app.platform_mode', true) = 'on'
      )
      WITH CHECK (
        id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        OR current_setting('app.platform_mode', true) = 'on'
      );
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='system_admins') THEN
    ALTER TABLE system_admins ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS platform_only ON system_admins;
    CREATE POLICY platform_only ON system_admins FOR ALL
      USING (current_setting('app.platform_mode', true) = 'on')
      WITH CHECK (current_setting('app.platform_mode', true) = 'on');
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3b. تنظيف السياسات القديمة (legacy) — إزالة كل سياسة غير معتمدة على جدول
--     صار له سياسة من العائلات الأربع.
--
--     سبب الحاجة: ملفات الترحيل أنشأت سياسات بأسماء لكل جدول
--     (`licenses_tenant_isolation`, `tenant_isolation_ledger_archive`, ...)،
--     بينما هذه الطبقة تُنشئ الأسماء المعتمدة. في PostgreSQL السياسات
--     Permissive تُدمج بـ OR، فوجود الاسمين ليس ثغرة — لكنه يترك نسخة أضعف
--     (مقارنة نصية بلا NULLIF) ويجعل verify-rls.mjs يفشل بـ "unexpected policy".
--
--     القيد الآمن: لا نحذف سياسة إلا إذا كان الجدول نفسه يحمل سياسة معتمدة —
--     فلا يبقى أي جدول بلا أي سياسة بعد التنظيف.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  canonical text[] := ARRAY['tenant_isolation','platform_or_tenant','tenant_directory','platform_only'];
BEGIN
  FOR r IN
    SELECT p.schemaname, p.tablename, p.policyname
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND NOT (p.policyname = ANY(canonical))
      AND EXISTS (
        SELECT 1 FROM pg_policies c
        WHERE c.schemaname = p.schemaname
          AND c.tablename = p.tablename
          AND c.policyname = ANY(canonical)
      )
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. FORCE ROW LEVEL SECURITY (D5 / DFP-018) — restricts even table owner.
--    Applied to every public table that carries tenant_id. Idempotent.
-- ────────────────────────────────────────────────────────────────────────────
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
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
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

-- ============================================================================
-- 5. ROLLBACK (الطوارئ) — تعطيل RLS كاملاً على كل جداول public
-- ============================================================================
-- DO $$ DECLARE t text; BEGIN
--   FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
--     EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY; ALTER TABLE %I DISABLE ROW LEVEL SECURITY;', t, t);
--   END LOOP;
-- END $$;
