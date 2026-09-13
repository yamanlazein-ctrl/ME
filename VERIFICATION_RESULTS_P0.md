# Verification Results — P0 pass 1

Source of work: the user-supplied **Verification Report**. Method: one problem at a
time, in the report's own order — root cause → fix → **real** verification →
regression check → PASS/FAIL with evidence. No moving on before PASS.

Legend: **PASS** = verified by executed commands, not by reading code.

---

## ID | المشكلة | ما تم إصلاحه | Verification | PASS/FAIL | الدليل

| ID | المشكلة | ما تم إصلاحه | Verification | PASS/FAIL | الدليل |
|---|---|---|---|---|---|
| **P0-001** | Journal/file skew — `0046_user_pin_hash.sql` على القرص فقط، غير مسجَّل في `_journal.json`، فلا يُنفَّذ على قاعدة طازجة | سُجِّل `0046_user_pin_hash` في موضعه الزمني الصحيح (idx 47، `when=1788900000000` بين 0045 و0047) مع إزاحة 0047-0051 إلى idx 48-52 | تشغيل migrator حقيقي (drizzle-kit CLI) على قواعد طازجة + مسار ترقية لتثبيت قائم | **PASS** | `drizzle-kit migrate` على قاعدة طازجة → exit 0، "migrations applied successfully!"، 53 migration، `users.pin_hash` **PRESENT**. قبل الإصلاح: 52 migration و`pin_hash` **MISSING**. ترقية نسخة من `fabric_erp` (40→53) → `pin_hash` PRESENT. حارس دائم: `backend/tests/migrations-journal-guard.test.ts` 6/6 |
| **P0-002** | RLS غير مُثبت وقت التشغيل + `0029` قديم: `current_setting(...)::uuid` بلا NULLIF، و6 جداول sync غائبة من `enable-rls.sql` | (1) `0029_rls_hardening.sql`: تغليف الـcast بـ`NULLIF(...,'')`. (2) `enable-rls.sql`: إضافة الجداول الستة للعائلة tenant-scoped + تنظيف السياسات القديمة المتجاوَزة. (3) `verify-rls.mjs`: ضبط العدد المتوقع 29→34 (مقيس فعليًا). (4) إنشاء `scripts/apply-rls.mjs` المفقود | اختبار ساكن + عقد RLS على قاعدة حيّة + اختبار عزل وظيفي بالدور الحقيقي `app_user` | **PASS** | `rls-guard.test.ts` 8/8 (كان 7/8). `verify-rls.mjs` → **OK**: 44 جدولًا، العائلات 34/8/1/1، app_user NOBYPASSRLS. العزل الوظيفي **6/6**: A لا يرى صفوف B، قراءة عابرة للشركات = 0، إدخال عابر مرفوض، `GUC=''` و`RESET` يُعيدان 0 صفوف بلا خطأ. **Falsifiability**: على نسخة 0029 القديمة → 4/6 مع `invalid input syntax for type uuid: ""` بالحرف |
| **P0-003** | إلغاء التثبيت يمسح بيانات العميل الحيّة (`rmdir /s /q "%LOCALAPPDATA%\motard-erp"`) | نُقل المسح خلف خاصية opt-in عامة: `MOTARD_WIPEDATA`. الشرط الآن `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND MOTARD_WIPEDATA="1"`. الافتراضي = **البيانات محفوظة**. حُدِّث `desktop/BUILD-WINDOWS.md` | ترجمة الـfragment الحقيقي بسلسلة أدوات WiX الفعلية + فحص وجود البوابة في المخرَج المُترجم | **PASS** | `candle.exe` على `wix-cleanup.wxs` → exit 0؛ المخرَج المُترجم يحتوي `MOTARD_WIPEDATA="1"` والـpayload. إعادة البناء بالشرط القديم تُزيل البوابة → قابل للدحض. `rmdir` لا يوجد في أي مكان آخر |
| **Blocker #7** | Fresh `db:migrate` غير موثوق (NOT VERIFIED) | لم يحتج إصلاحًا — كان غير مُتحقَّق منه فقط | تشغيل `drizzle-kit migrate` الحقيقي على قاعدة طازجة | **PASS (VERIFIED)** | exit 0، "migrations applied successfully!"، 53/53 migration، `pin_hash` PRESENT، جداول sync بـRLS+FORCE |

---

## Test infrastructure used for real verification

`psql` و`initdb` محجوبان في هذه البيئة (exit 127)، لذلك:

- عنقود **PostgreSQL 17.10 معزول** منسوخ إلى `.workbuddy-ai/pgtest/pgdata`
  (نسخة من `Program Files\PostgreSQL\17\data`، trust auth) ويعمل على المنفذ
  **5432**. **بياناتك الحقيقية لم تُمس** — العمل كله داخل النسخة.
- سكربتات التحقق في `.workbuddy-ai/pgtest/`: `verify-fresh-migrate.mjs`،
  `verify-upgrade-path.mjs`، `verify-rls-functional.mjs`، `apply-sql.mjs`،
  `inspect-db.mjs`.

## Regression status — full backend suite

```
Test Files  2 failed | 14 passed (16)
Tests       1 failed | 109 passed | 10 skipped (120)      Duration 33.65s
```

مقابل خط الأساس في التقرير (بلا قاعدة بيانات): `7 failed | 8 passed (15)` و
`2 failed | 93 passed | 19 skipped (114)`.

الفشلان المتبقيان **ليسا من هذه الإصلاحات**:

1. `audit-findings.test.ts` — E2E يحتاج باك-إند يعمل على `127.0.0.1:8080`
   (`ECONNREFUSED`). بيئي.
2. `licensing-engine.test.ts` — `resolveFeatures("basic")` يُعيد
   `[feature.inventory, feature.accounting]` والمتوقع `[feature.inventory]`.
   هذا هو البند **P1-004b** في التقرير ولم يُعالَج بعد.

`rls-guard.test.ts` صار 8/8، والحارس الجديد `migrations-journal-guard.test.ts` 6/6.

## Files changed

```
 M backend/scripts/verify-rls.mjs
 M backend/src/infrastructure/orm/migrations/0029_rls_hardening.sql
 M backend/src/infrastructure/orm/migrations/meta/_journal.json
 M backend/src/infrastructure/orm/rls/enable-rls.sql
 M desktop/BUILD-WINDOWS.md
 M desktop/src-tauri/wix-cleanup.wxs
?? backend/scripts/apply-rls.mjs                 (new — was referenced but missing)
?? backend/tests/migrations-journal-guard.test.ts (new — regression guard)
```

## Findings recorded but NOT yet fixed (need their own item)

- **Upgrading `erp` fails at `0032_cash_ledger_fix.sql`**: its
  `__drizzle_migrations` says 0022 while the live schema already carries the
  0036b append-only trigger, so the migration's `UPDATE ledger_entries` is
  rejected. Stale/hand-mutated DB state — unrelated to the journal fix.
- **`enable-rls.sql` is applied by no automated step** and was absent from CI;
  `scripts/apply-rls.mjs` did not exist. (CI wiring = P1-004a / P1-007.)
- No database in this environment has 0047-0051 applied (erp@0022,
  fabric_erp@0038); `erp` has `pin_hash` only via `server.ts`'s raw
  `ensureDesktopSchema` DDL, not via migrations (P0 blocker #6).

## Next in order

**P0-004** (Bearer in plain localStorage + Redis-or-no-op revocation +
refresh rotation missing). Two architectural forks need a decision before
touching it — see the question in the reply.
