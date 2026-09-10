-- ============================================================================
-- rls_staging_matrix.sql — مصفوفة العزل: يُنفَّذ بدور rls_probe (غير مالك)
-- كل سطر يطبع نتيجة عدّية للتحقق.
-- ============================================================================
\set ON_ERROR_STOP off
\pset footer off
\pset format unaligned

-- A = '00000000-0000-0000-0000-0000000000a1' , B = '...b2'

\echo '=== M1: GUC=A  -> SELECT invoices (نتوقع 1) ==='
SET app.current_tenant_id = '00000000-0000-0000-0000-0000000000a1';
SELECT count(*) AS cnt FROM invoices;

\echo '=== M2: GUC=A  -> SELECT invoice_lines (نتوقع 1) ==='
SELECT count(*) AS cnt FROM invoice_lines;

\echo '=== M3: GUC=B  -> SELECT invoices (نتوقع 1) ==='
SET app.current_tenant_id = '00000000-0000-0000-0000-0000000000b2';
SELECT count(*) AS cnt FROM invoices WHERE number = 'INV-B-1';

\echo '=== M4: لا GUC  -> SELECT invoices (نتوقع 0) ==='
RESET app.current_tenant_id;
SELECT count(*) AS cnt FROM invoices;

\echo '=== M5: لا GUC  -> SELECT invoice_lines (نتوقع 0) ==='
SELECT count(*) AS cnt FROM invoice_lines;

\echo '=== M6: GUC=A  -> INSERT بشرط tenant_id=B (نتوقع رفض) ==='
SET app.current_tenant_id = '00000000-0000-0000-0000-0000000000a1';
INSERT INTO invoices (id, tenant_id, number)
VALUES ('30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000b2','INV-B-2');

\echo '=== M7: GUC=A  -> UPDATE صف B (نتوقع 0) ==='
SELECT count(*) AS affected FROM (UPDATE invoices SET number='HACKED' WHERE id='20000000-0000-0000-0000-000000000002' RETURNING id) _;

\echo '=== M8: GUC=A  -> DELETE صف B (نتوقع 0) ==='
SELECT count(*) AS affected FROM (DELETE FROM invoices WHERE id='20000000-0000-0000-0000-000000000002' RETURNING id) _;

\echo '=== M9: GUC=A  -> INSERT صف A (نتوقع نجاح) ==='
INSERT INTO invoices (id, tenant_id, number)
VALUES ('40000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000a1','INV-A-2');

\echo '=== M10: GUC=A -> child عزل (invoice_lines عبر parent B؟ نجيب 0) ==='
SELECT count(*) AS cnt FROM invoice_lines WHERE invoice_id = '20000000-0000-0000-0000-000000000002';

\echo '=== M11: GUC=A -> عدّ صفوف A بعد الإدخال (نتوقع 2) ==='
SELECT count(*) AS cnt FROM invoices WHERE tenant_id = '00000000-0000-0000-0000-0000000000a1';
