# RLS-ENABLEMENT-PLAN.md — خطة تفعيل عزل الشركات (RLS) — النسخة النهائية المعتمَدة

> **الحالة:** خطة معتمَدة مبدئياً، في انتظار اعتماد التنفيذ النهائي.
> **لم يُنفَّذ أي تعديل كود حتى الآن.** التعديل الوحيد هو هذا الملف التوثيقي.
> **الأساس:** قرارات المالك D1–D5 + شرطان إضافيان (auth-order + no-direct-db) من المراجعة.

---

## 0. القرارات المعتمَدة (سجل الالتزام)

| # | القرار | الحكم النهائي |
|---|---|---|
| D1 | مصدر المخطط | **`drizzle-kit migrate`** مصدر الحقيقة النهائي — مع معالجة تاريخ الـmigrations أولاً (reconciliation/baseline) وعدم القفز من `db:push` مباشرة |
| D2 | غرس GUC | **توسيع `withTenantTx` + `SET LOCAL` داخل transaction/request-scoped** — **ممنوع** `SET SESSION` على الـshared pool |
| D3 | سطح المكتب | **لا RLS الآن** — مسار منفصل لاحقاً |
| D4 | تصنيف NULL | **إعادة تصميم**: ثلاث فئات منفصلة بسياسات منفصلة (انظر §3) — **بدون** سياسة عامة `NULL OR tenant` |
| D5 | FORCE+NOBYPASSRLS | staging أولاً، ثم dev بعد نجاح كل اختبارات العزل |

---

## 1. الشرطان الإضافيان المعتمَدان (من المراجعة)

### شرط-1: حل توقيت قراءة `users` في auth.middleware
**المشكلة المؤكدة:** `auth.middleware.ts:19-23` (`resolveUserName`) يقرأ جدول
`users` عبر `db` (الـpool المشترك) **قبل** توفر أي GUC. `users` جدول
tenant-scoped (`tenant_id NOT NULL`) وسيعود صفراً تحت RLS.

**مصدر الـtenant الموثوق (بدون circular dependency):**
الـJWT مُوثَّق ومُوقَّع من طرفنا (HS256) **قبل** أي وصول للقاعدة، ويحمل
`payload.tenantId` صراحةً (`auth.middleware.ts:53-58`). إذن **الـtenantId من
الـJWT المُتحقق هو المصدر الموثوق** — لا توجد دائرية: المصادقة سبقت السياق،
والسياق يُشتق من الـtoken نفسه لا من قاعدة البيانات.

**الحل المعتمَد (خياران يُحسم أحدهما في التنفيذ، كلاهما يزيل القراءة المبكرة):**
- **(أ) المُفضَّل:** إضافة claim `name` إلى الـJWT وقت الإصدار → لا قراءة لـ`users`
  إطلاقاً في الـmiddleware (الاسم من الـtoken). يزيل الجذر كاملاً.
- **(ب) الاحتياطي:** لفّ قراءة `resolveUserName` داخل `withTenantTx(payload.tenantId, ...)`
  بدل `db` المباشر، مع بقاء الكاش في الذاكرة.

> يُسجَّل الاختيار كتابياً أثناء التنفيذ. الشرط ملزم أياً كان الخيار: **صفر
> وصول مباشر لـ`users` قبل ضبط GUC.**

### شرط-2: منع العودة لاستخدام `this.db` المباشر
**المشكلة:** الـ25+ مستودعاً تشغيلياً تستقبل `db: DB` (الـpool المشترك) وتنفذ
`this.db.select(...)` بلا GUC. بعد الإصلاح يجب أن يستحيل على أي كود جديد (أو
مُعدَّل) تجاوز سياق الـtenant.

**الحل المعتمَد (ثلاث طبقات دفاع):**
1. **نوع مُخصص:** حذف `this.db` المباشر من tenant-scoped repos واستبداله بوسيط
   `TenantDb` يستلزم `tenantId` إلزامياً في كل استدعاء.
2. **Guard معماري (lint):** قاعدة ESLint مخصصة تمنع `import { db } from "../orm/drizzle"`
   داخل `backend/src/infrastructure/repositories/*.ts` (يسمح فقط بـ`withTenantTx`/الوسيط المعتمد).
3. **اختبار معماري:** اختبار vitest يقرأ AST كل مستودع ويتأكد من خلوّه من استيراد
   `db` المباشر (يفشل CI عند المخالفة).

---

## 2. فهم العزل الحالي (الأرضية)

- JWT يحمل `tenantId` → `auth.middleware.ts:53-58` يبني `req.tenantContext` **في الذاكرة فقط** (بلا `SET`).
- كل مستودع يستقبل `ctx: TenantContext` ويضيف `eq(table.tenantId, ctx.tenantId)` يدوياً.
- **مساران غير متكافئين:** `withTenantTx()` (يضبط GUC، مستخدم في 4 مستودعات منصة فقط)
  مقابل `this.db` المشترك (بلا GUC، مستخدم في كل المستودعات التشغيلية).
- `setTenantForRequest` (`drizzle.ts:24-26`) يستخدم `SET LOCAL` عبر `pool.query` **خارج معاملة** (لا معنى له).
- `tenant.middleware.ts:23` يستخدم `SET SESSION` (منهوش) وغير مسجّل أصلاً في `server.ts`.

---

## 3. تصنيف الجداول — ثلاث فئات منفصلة (D4 المعاد تصميمه)

> لا توجد سياسة `tenant_id IS NULL OR tenant` عامة. كل فئة بسياسة صريحة مستقلة.

### الفئة 1 — tenant-scoped (tenant_id NOT NULL) — بيانات الأعمال
سياسة صارمة: `USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)`

الجدول | المصدر
---|---
invoices, invoice_lines, parties, users | `invoice.table.ts:20`, `invoice-line.table.ts:22`, `party.table.ts:20`, `user.table.ts:17`
fabrics, colors, rolls | `fabric.table.ts:8`, `color.table.ts:9`, `roll.table.ts:20`
orders, order_items | `order.table.ts:19`, `order-item.table.ts:21`
returns, return_lines | `return.table.ts:20`, `return-line.table.ts:10`
vouchers, ledger_entries, ledger_entry_archive | `voucher.table.ts:22`, `ledger-entry.table.ts:19`, `ledger-entry-archive.table.ts:29`
stock_movements, expenses | `stock-movement.table.ts:15`, `expense.table.ts:19`
cashbox (sessions/rows) | `cashbox.table.ts:16,28,46`
document_sequences, idempotency_keys | `document-sequence.table.ts:8`, `idempotency-key.table.ts:39`
notifications, settings, print_jobs, audit_logs, attachments | `notification.table.ts:7`, `setting.table.ts:6`, `print-job.table.ts:22`, `audit-log.table.ts:18`, `attachment.table.ts:6`
yearly_party_summaries | `yearly-party-summary.table.ts:30`
company_profiles, setup_wizard_state (PK=tenant) | `company-profile.table.ts:31`, `setup-wizard-state.table.ts:21`
device_registrations, invitation_codes, license_activations | `device-registration.table.ts:25`, `invitation-code.table.ts:10`, `license-activation.table.ts:24`

### الفئة 2 — platform/system-owned (tenant_id NULLABLE) — **ليست مرئية تلقائياً لكل الشركات**
> صفوف `tenant_id = NULL` تمثّل ملكية نظام/منصة فقط، وتُقرأ **حصرياً** عبر
> مسارات platform معتمدة (License Server / bootstrap) بسياق إداري صريح،
> **ليس** عبر `NULL OR tenant`.

الجدول | السياسة
---|---
`licenses` | صف NULL = system-level (قبل التفعيل). قراءة إدارية **فقط** عبر سياق platform؛ صفوف tenant-scoped تُقرأ حسب `tenant_id`
`secrets` | صف NULL = system-level secret (بصمة المفتاح). **لا يقرؤه أي tenant نهائياً** — سياق platform/admin فقط
`server_installations` | صف NULL = تسجيل تركيب قبل الربط؛ سياق platform فقط
`license_audit_events` | append-only؛ صف NULL = حدث system-level؛ سياق platform فقط

**الآلية المعتمَدة لكلا الفئتين 1 و2:** دور قاعدة بيانات منفصل/سياق ترخيص صريح،
بحيث "visibility" تتحدد بالمسار (platform bootstrap) أو بالدور، **وليس** بشرط
`NULL OR tenant` الذي سيفتح الصفوف النظامية لكل الشركات.

### الفئة 3 — genuinely global (بلا عمود tenant_id) — دليل المنصة
| الجدول | السياسة |
|---|---|
| `tenants` | دليل الشركات — قراءة لكل مجيب مُوثَّق (لإثبات identity/status)، كتابة platform فقط |
| `system_admins` | هويات super-admin — **قراءة platform فقط**، لا tenant نهائياً |
| `schema_migrations` | جدول أداة migrate — خارج RLS (أداة فقط) |

---

## 4. خطة التنفيذ النهائية (٧ مراحل)

### المرحلة A — خط الأساس (بدون تعديل)
1. توثيق `relrowsecurity` لكل جدول، مالك الجداول، دور الاتصال الفعلي، عدد الـmigrations المطبّقة.
2. تحديد هوية الاتصال بالإنتاج (`app_user` غير مالك → RLS تلقائي؛ مالك → FORCE مطلوب).
3. تسجيل دورة انحدار أساسية (فاتورة→سند→تقرير→كشف) تُعاد بعد كل مرحلة.

### المرحلة B — معالجة تاريخ الـmigrations (D1، قبل أي RLS)
1. **Baseline/Reconciliation:** مقارنة المخطط الفعلي (ناتج `db:push`) بمخطط TS snapshot.
2. تجميد `db:push` واعتماد `migrate` بخطة متدرجة (استيراد baseline + إكمال journal).
3. **مخرج:** `drizzle-kit migrate` قادر على إعادة إنتاج المخطط على قاعدة فارغة (تحقق حي).

### المرحلة C — توحيد سياق الـtenant + حل شرط-1 (تعديل كود، بلا تغيير سلوك)
1. تصليح `auth.middleware` (حل شرط-1: خيار أ/ب).
2. توسيع `withTenantTx` ليشمل القراءات، وإدخال request-scoped context (D2).
3. تحويل المستودعات التشغيلية الـ25+ إلى المسار الموحّد (لا تغيير منطق أعمال).
4. إصلاح `setTenantForRequest` (SET LOCAL داخل معاملة) / إزالة أو تصحيح `tenant.middleware.ts`.
5. **شرط-2:** إضافة lint + اختبار معماري يمنعان `this.db` المباشر.
6. **مخرج:** انحدار A.3 يمرّ مطابقاً (RLS ما زال مُطفأ).

### المرحلة D — تفعيل RLS على `erp_rls_staging` (معزولة) + مصفوفة عزل كاملة
1. إنشاء قاعدة معزولة بنسخة مطابقة.
2. تطبيق الفئات الثلاث (سياسات الفئة 1/2/3) + `FORCE` + دور `NOBYPASSRLS` (D5).
3. تصحيح `0029` (اسم القاعدة، كلمة المرور placeholder) وفصله إلى policies حسب الفئات.
4. **مصفوفة العزل الشاملة (Tenant A ↔ Tenant B):**

| العملية | الفئة 1 (business) | الفئة 1 child (`invoice_lines` وغيره) | الفئة 2 NULL (`licenses`/`secrets`) | الفئة 3 (`tenants`/`system_admins`) |
|---|---|---|---|---|
| SELECT (A يرى B) | ❌ ممنوع | ❌ ممنوع | ❌ ممنوع (NULL ليست عامة) | دليل visible / هويات admin ❌ |
| SELECT (تدقيق بلا GUC) | ❌ صفر صفوف | ❌ صفر صفوف | ❌ | ❌ |
| INSERT (tenant_id = B من سياق A) | ❌ ممنوع | ❌ | ❌ | ❌ |
| UPDATE (صف B من A) | ❌ ممنوع | ❌ | ❌ | ❌ |
| DELETE (صف B من A) | ❌ ممنوع | ❌ | ❌ | ❌ |
| INSERT/UPDATE/DELETE (صف A من A) | ✅ مسموح | ✅ | ✅ (ضمن tenant) | كتابة platform فقط |

   **الشرط الحاسم:** إثبات أن RLS يمنع الوصول **حتى عند غياب** `WHERE tenant_id`
   في كود التطبيق (إزالة الفلتر عمداً في اختبار staging وإثبات الصفر/المنع).

### المرحلة E — الترقية إلى قاعدة التطوير الحية
1. نسخة احتياطية كاملة. 2. تطبيق نفس سكربت D. 3. انحدار كامل + دورة حية.

### المرحلة F — منع الانتكاس
1. RLS في TS schema (حيث يدعم Drizzle) + توثيق الـSQL اليدوي.
2. قرار موثّق في `docs/decisions.md`. 3. فحص `relrowsecurity` في CI/التحقق الدائم.

### المرحلة G — (لاحقاً، منفصل) قاعدة سطح المكتب (D3) — خارج هذا التنفيذ.

---

## 5. الملفات المتأثرة (تقدير للتنفيذ القادم)

| النطاق | الملفات | نوع التغيير |
|---|---|---|
| توقيت auth | `backend/src/infrastructure/http/middleware/auth.middleware.ts` | شرط-1 (إضافة claim أو withTenantTx) |
| إصدار JWT | `backend/src/infrastructure/auth/JwtSigner.ts` (إن اعتُمد خيار أ) | إضافة claim `name` |
| سياق tenant | `backend/src/infrastructure/orm/drizzle.ts` | توسيع `withTenantTx` + وسيط `TenantDb` |
| المستودعات (25+) | `Postgres*Repository.ts` (Invoice/Voucher/Party/Roll/Order/Return/Ledger/Cashbox/Expense/Dashboard/Statement/Notification/Settings/Audit/Profit/PrintJob/StockMovement…) | تحويل `this.db` → وسيط tenant |
| وسطاء مهجورة | `backend/src/infrastructure/http/middleware/tenant.middleware.ts` | تصحيح/إزالة + تسجيل صحيح |
| migration SQL | `0029_rls_hardening.sql` (+ ملف جديد بسياسات الفئات) | تصحيح الاسم/placeholder + فصل الفئات |
| migrations baseline | `migrations/meta/_journal.json` + baseline جديد | reconciliation (B) |
| حماية الاستخدام | `.eslintrc`/eslint plugin + `**/*.test.ts` معماري | شرط-2 |
| التوثيق | `docs/decisions.md` | قرار RLS الموثّق |

---

## 6. ترتيب التنفيذ (الاعتماديات)

```
A (أساس) → B (migrate baseline) → C (كود + شرط1 + شرط2) → D (staging RLS + مصفوفة)
         → E (dev حي) → F (منع الانتكاس)
```
- B يمكن أن يتقدم قبل/بالتوازي مع C (مستقلان)، لكن **C يجب أن يكتمل قبل D**.
- D لا تبدأ قبل نجاح انحدار C (السلوك مطابق + RLS مُطفأ).
- E لا تبدأ قبل نجاح مصفوفة D كاملة.

---

## 7. نقاط Rollback (explicit)

| النقطة | آلية التراجع |
|---|---|
| B (migrate baseline) | الاحتفاظ بـ`db:push` عاملاً جانبياً + نسخة journal قبلية + إمكانية العودة لـpush |
| C (تحويل المستودعات) | كل تحويل مستودع مستقل git commit → `git revert` فردي دون المساس بغيره |
| D (staging RLS) | قاعدة معزولة قابلة للحذف/إعادة الإنشاء — **ليست** قاعدة حية |
| E (dev RLS) | نسخة احتياطية `pg_dump` قبلية + سكربت `DROP POLICY`/`ALTER TABLE ... NO FORCE`/`DISABLE ROW LEVEL SECURITY` قابل للتشغيل لإلغاء RLS فوراً |
| أي كسر انحدار | إيقاف فوري + استعادة النسخة الاحتياطية + تقرير قبل المتابعة |

**خطة التراجع الفوري لقاعدة dev (تعطيل RLS كاملاً):**
```sql
-- في حالة الطوارئ فقط: إلغاء RLS على كل جداول public
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY; ALTER TABLE %I NO FORCE ROW LEVEL SECURITY;', t, t);
  END LOOP;
END $$;
```
(تُحفظ كسكربت جاهز `rollback-disable-rls.sql` قبل المرحلة E، لا تُنفَّذ إلا طوارئ.)

---

## 8. حدود التنفيذ (ما لن يتغير)

- لا تغيير في منطق الأسعار/التكلفة/القيود المحاسبية/الترقيم.
- لا لمس `desktop/` (D3).
- لا commit/push حتى اعتماد نهائي لكل مرحلة على حدة.

---

*نهاية النسخة النهائية — بانتظار اعتماد التنفيذ.*
