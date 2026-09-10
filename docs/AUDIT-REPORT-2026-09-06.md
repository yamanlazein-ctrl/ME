# تقرير التدقيق الشامل — fabric-erp (2026-09-06)

نطاق: backend/ frontend/ database/ desktop/ licensing/ invitations/ RLS/ deploy.
طريقة: READ → INSPECT → RUN → TEST → REPORT. لا تعديل كود، لا commit/push، لا حذف بيانات المستخدم.
بيئة الاختبار الحية: PostgreSQL 17.10 @127.0.0.1:5432 قاعدة erp، backend :8080 (يتصل بـ app_user NOBYPASSRLS)، Vite :5173.

---

## 1) خريطة الطلب: Request → Auth → Tenant → UseCase → Repository → DB → RLS

سلسلة middleware الفعلية (backend/src/presentation/server.ts):
helmet → compression → CORS (allowlist) → rateLimit عام (ذاكرة) → requestId → json(10mb) → request-log → install gate → license heartbeat (لا يمنع) → [جذر: health/auth/license/setup/company/invitations] → [/api: authMiddleware → licenseGuard → feature gates → routes → (fallback: auth+rbac(admin)+backupRouter)] → 404 JSON → Sentry → error handler.

سياق المستأجر: auth.middleware.ts:59 يشتق tenantId من **JWT موقّع** (وليس من الطلب) عبر `runWithTenantContext` (AsyncLocalStorage)، وdrizzle.ts يختم `app.current_tenant_id` + `app.platform_mode` على **كل اتصال عند الـ checkout** (TenantScopedPool). لا يوجد أي مسار مسجل يضبط GUC من رأس/جسم طلب.

**الجواب: لم أجد أي طريق يتجاوز tenant/security عبر HTTP.** المسارات خارج السياق (login/refresh/logout/me/health/setup/invitation validate+consume) إما لا تلمس جداول cat-1 بلا غرض، أو تختم السياق داخلياً (PostgresAuthRepository يختم GUC من tenantId الصريح في login، وauth routes تختمه من JWT قبل findUserById).

## 2) السيناريو الواقعي الكامل (24 خطوة) — 33/34 ✅

سكربت الأدلة: backend/scripts/_audit-scenario.mjs (تشغيل حي كامل، مقتطفات الحالات أدناه).

| # | الخطوة | النتيجة | دليل |
|---|---|---|---|
| 1 | دخول admin | ✅ 200 | accessToken صدر |
| 2 | /auth/me (role/tenant) | ✅ | role=admin, tenantId صحيح |
| 2b | ملف الشركة | ✅ 200 | /api/company/profile |
| 3 | admin ينشئ دعوة محاسب | ✅ 200 | code=E3FA-… |
| 4 | validate (بلا auth) | ✅ 200 | valid=true |
| 4b | consume → مستخدم محاسب | ✅ 200 | createdUserId + tenantId=A |
| 4c | الاستخدام مرة واحدة | ✅ 400 | بعد consume → invalid |
| 5 | دخول المحاسب | ✅ 200 | role=accountant |
| 6 | رؤية بيانات شركته فقط | ✅ | عدّد فواتيره = عدّد الأدمن (46) |
| 7 | إنشاء عميل/مورد | ✅ 201 | /api/customers, /api/suppliers |
| 8 | قماش/لون/لفافة | ✅ 201 | **admin/warehouse فقط (بالتصميم)** — المحاسب 403 |
| 9 | فاتورة دخول (SYP, fx=13500, لفافة فارغة) | ✅ 201 ENT-2026-0029 | مخزون 0→50kg |
| 10 | فاتورة بيع | ✅ 201 INV-2026-0024 | مخزون 50→30kg |
| 11 | تعديل الفاتورة 20→19kg | ✅ 200 | مخزون 30→31kg |
| 12 | إلغاء الفاتورة | ✅ 200 | مخزون عاد 31→50kg |
| 13 | سند قبض | ✅ 201 VOC-2026-0066 | /api/receipts |
| 14 | سند دفع | ✅ 201 VOC-2026-0067 | /api/payments |
| 15 | لوحة المعلومات | ✅ 200 | /api/dashboard |
| 16 | قيود محاسبية | ✅ SQL | 34 قيداً (sales_invoice 16, purchase 6, receipt_in 8, payment_out 4) للسيناريو |
| 17 | الربح/الخسارة | ✅ 200 | /api/profit/summary (SYP: مبيعات 10,090,060، ربح إجمالي 1,943,010) |
| 18/19 | كشف عميل/مورد | ✅ 200 | /api/customers/:id/statement |
| 20 | تقارير المبيعات/المخزون | ✅ 200 | قوائم مفلترة |
| 22 | خروج | ✅ 204 | /api/auth/logout |
| 22b | موت الرمز بعد الخروج | ❌ 200 | **بدون Redis: الـ denylist لا يعمل** (TokenDenylist.ts:19-28 `if (!this.redis) return`) |
| 23 | دخول مجدد | ✅ 200 | |
| 24 | ثبات البيانات | ✅ | الفاتورة status=cancelled محفوظة |

تدقيق المراجعة (audit): 16 سجل تدقيق للسيناريو (create 5 / update 2 / cancel 3 للفواتير + 6 للسندات) — actor مسجل.
حركات المخزون: initial 4 / invoice_entry 4 / invoice_sale 6.

## 3) مصفوفة الصلاحيات (حية)

**Admin (ALLOW ✅ / DENY ✅ / MISSING ❌):**
- إدارة المستخدمين (تعطيل/تفعيل): ❌ **MISSING — لا يوجد أي endpoint لإدارة المستخدمين** (لا يوجد users.route؛ الإنشاء فقط عبر الدعوات، ولا يمكن تعطيل مستخدم من الواجهة البرمجية إطلاقاً)
- إنشاء محاسب عبر دعوة: ✅ (admin-only guard)
- إدارة الدعوات (generate/list/revoke): ✅ admin-only (live 403 للمحاسب)
- الترخيص (status/features/devices/transfer/heartbeat/audit): ✅ admin-only (license.route.ts:32-33 rbac(["admin"]))
- نسخة احتياطية كاملة: ✅ admin-only (live 403 للمحاسب + double-check داخل backup.route.ts:21-25)
- تعديل ملف الشركة: ✅ admin-only (المحاسب 403 حي)
- رؤية audit-logs: ✅ 200 (admin + كل الأدوار فعلياً — rbac الأربعة في server.ts:320-325)
- إعدادات (كتابة): ✅ admin-only (المحاسب 403 حي)

**Accountant:**
- إنشاء فاتورة/تعديل/إلغاء: ✅ ALLOW (حية)
- سند قبض/دفع: ✅ ALLOW (حية)
- قراءة عملاء/موردين/مخزون/تقارير/ربح: ✅ ALLOW
- إنشاء قماش/لون/لفافة/حركة مخزون يدوية: ✅ DENY (403 حي — تصميم warehouse/admin)
- إدارة المستخدمين/الدعوات/الترخيص/الإعدادات/النسخ: ✅ DENY (403 حي)
- platform-only data (licenses list/secrets/system_admins): ✅ DENY (401/403 + RLS يخفيها تماماً بلا platform_mode)
- MISSING الوحيد وظيفياً: لا يستطيع المحاسب إنشاء الأصناف الأساسية (قماش/لون/لفافة) — يتطلب مستخدم warehouse/admin.

## 4) دورة الفواتير + إعادة اختبار الفجوتين

- Sale/Entry: إنشاء، ترقيم تسلسلي (INV/ENT-2026-XXXX عبر document_sequences)، tenant_id مختوم من السياق، سطور (fabric/color/roll/qty/price)، خصم/ضريبة/شحن، حركة مخزون فورية، قيود مزدوجة، إلغاء مع استرجاع المخزون، audit كامل، صلاحيات accountant-and-up. ✅ كله حي.
- قواعد النطاق الحية (من E-2 + اليوم): fx مطلوب لغير USD، لفافة الدخول يجب أن تكون فارغة جديدة، لون السطر يطابق لون اللفافة.
- **عبر المستأجرين عبر API:**
  - فاتورة B بعطية A → **422 «الطرف المحدد للفاتورة غير موجود»** ✅ (الـuse-case يتحقق عبر قراءة مُفلترة)
  - سند B بعطية A → **201 — الفجوة قائمة** (voucherUseCases.ts:18 يتحقق من وجود partyId فقط لا رؤيته). لا تسريب بيانات (القراءة مُفلترة)، لكن مرجع معطل في تقارير B. ⚠️
  - لفافة B بلون A → **201 — الفجوة قائمة** (لا تحقق رؤية للـ colorId عند إنشاء اللفافة). ⚠️
  - حقن tenantId=B في الجسم → يُهمل (422)؛ X-Tenant-Id وX-Platform-Mode يُهمَلان ✅

## 5) RLS وmulti-tenant (حي)

- الكتالوج: 39 جدول RLS ON / **0 FORCE RLS** / 41 جدول / 39 سياسة (tenant_isolation 29, platform_or_tenant 8, tenant_directory 1, platform_only 1) / app_user NOBYPASSRLS / postgres superuser (مالك فقط للأدمن).
- المصفوفة (سكربت _rls-isolation-ab.mjs: 39/39): قراءة/تعديل/حذف/إدخال عبر API وSQL مباشر بصف app_user — A→A ✅, A→B ❌ (404/0 rows), B→B ✅, B→A ❌؛ invoice_lines مُفلترة؛ بلا GUC → 0 صفوف؛ INSERT بلا GUC → **42501**; platform_mode=on فقط يفتح secrets/system_admins/tenants/licenses.
- **PostgreSQL نفسها تمنع** — مثبت بصف app_user (لا BYPASSRLS) وليس فقط WHERE tenant_id.
- FORCE RLS متعمد إيقافه (D5) — الخطر الوحيد: اتصال بصف المالك postgres (لا يحدث وقت التشغيل).

## 6) Platform mode

- app.platform_mode يُضبط فقط عبر runWithPlatformContext (tenant-context.ts:48) من مسارات bootstrap/license-server الداخلية — لا رأس/كوكي/جسم يمكنه تزويره (حي: X-Platform-Mode مُهمل).
- التسريب بين الطلبات مستحيل معماريًا: الختم عند checkout لكل اتصال (drizzle.ts:40-48 يعيد ضبط القيمتين في كل مرة).
- license-admin routes (منصة) في scripts/license-admin.route.ts — **غير مسجلة في الخادم الرئيسي** (محصورة في license-server المنفصل بحمولة LICENSE_ADMIN_TOKEN + timingSafeEqual).

## 7) الترخيص

1. بلا license: `no_license` يمر (تصميم Grace) ✅ بالكود.
2/3. expired → سماح حتى expiresAt+graceDays مع رأس X-License-Grace ثم 403; revoked → 403 فوراً (license.guard.middleware.ts:24,68-79). suspended/no_license/active/trial تمر — **"suspended" يمر حالياً** (قرار يجب توثيقه).
4. feature غير مفعّل → 403 FEATURE_NOT_ENABLED (license.enforcement.middleware.ts:40).
5. status يتطابق مع الحارس نفسه (نفس المصدر heartbeat).
6. الفوترة/المخزون/الربح محكومة فعلياً بـ feature gates على /api (server.ts:189-193).
7. المحاسب تغيير الترخيص: ✅ DENY (403). 8. admin: ✅ ALLOW. 9. المنصة فقط: activate/transfer تعمل من tenant-admin لكن التوزيع الحقيقي عبر license-server.
10/11. مرتبطة بالـtenant وRLS (B لا يرى غير ترخيصه — حي: licenses=1 لـ B).
12. enforced في backend على كل /api (ليس UI فقط).
13. heartbeat ✅ 200 حي. 14. offline token EdDSA موجود (LicenseTokenSigner + bake-desktop-license) ✅ بالكود.
15. **خطر stale-license**: findLatestForTenant (PostgresLicenseRepository.ts:157-167) بلا فلتر status — حالة E-2 (ترخيص معطل أحدث حجب tenant) يمكن أن تتكرر. ⚠️

## 8) الدعوات (حي + كود)

توليد (admin) → كود 12 خانة من randomBytes(6) (48-bit) → validate بلا auth (يعيد tenantId — مقبول تصميمياً) → consume بلا auth ينشئ المستخدم: role من metadata الديباجة (المسموح: admin/accountant/warehouse/viewer فقط — لا تصعيد من المستقبِل)، tenantId من سجل الكود (لا يمكن تزويره)، حدّ المستخدمين/الأجهزة من الترخيص، **consume ذري** (UPDATE ... WHERE useCount=0 — PostgresInvitationRepository.ts:83-101) → إعادة الاستخدام 400، TTL 15د افتراضياً، revoke متاح.Brute-force: عمومياً rate-limited + 48-bit → غير عملي. audit trail للدعوات غير موجود كجدول مخصص (خفيف).
 invitation_codes: cat-2 platform_or_tenant — pre-auth validate يشتغل بقراءة via platform context داخلي مقصود.

## 9) Admin ينشئ Accountant (حي، كامل)

✅ كامل: دعوة → كود → قبول → مستخدم + tenant صحيح + role=accountant → دخول → وظائفه تعمل → محظور من admin/platform (403 حية). المحاسب لا يستطيع رفع صلاحياته (الدعوة الوحيدة للترقية يتولاها admin)، لا يغير tenant (من JWT)، لا يرى شركة أخرى (404/422).

## 10) Offline (سطح المكتب)

**حقيقي وقائم بذاته لكل جهاز**: desktop_runtime.rs يجهز data-dir لـ PostgreSQL (قالب مخبوز أو initdb) → يشغّل postgres.exe المدمج → أسرار DPAPI مشفرة محلياً → يشغّل backend (node.exe مدمج) → النافذة على 127.0.0.1. الترخيص: offline token EdDSA مُخبوز + public key مدمجة.
**لا توجد مزامنة سحابية**: كل جهاز = قاعدة مستقلة؛ نفس الحساب على جهازين = بيانات منفصلة تماماً (conflict handling غير موجود — لا محرك مزامنة في الكود). انتهاء الترخيص offline → grace ثم 403 محلياً.

## 11) Online

- **Local ✅**: كله يعمل (مثبت اليوم).
- **LAN ⚠️**: backend يستمع على كل الواجهات (app.listen(PORT)) — يعمل تقنياً، لكن بلا HTTPS وبلا توثيق نشر عكسي.
- **Production ❌/⚠️**: ينقص: HTTPS/reverse proxy (لا nginx ولا توثيق)، Redis مطلوب فعلياً للخروج/denylist (غيابه = خروج لا يعمل أمنياً)، migrate معطل، CORS production يتطلب origins صريحة (env.ts:87 يمنع "*")، SETUP_TOKEN إلزامي في production (env يرفض الإقلاع بدونه — جيد).

## 12) Fresh Server Install Test (من الصفر)

1-2. dependencies/PostgreSQL: موثقة عبر docker-compose (PG16 ≠ PG17 المحلي — انحراف إصدار).
3-5. قاعدة جديدة: **db:migrate يفشل (exit 1، صفر جداول، بلا رسالة)** — أُعيد إنتاجه حياً اليوم على erp_mig_test.
6. البديل المثبت: db:push على قاعدة فارغة → **38/39 جدولاً مع RLS مفعّلة تلقائياً** (بفضل enableRLS في المخطط — Phase F1).
7. RLS: push يفعل relrowsecurity؛ **السياسات تحتاج enable-rls.sql يدوياً** (نفّذته حياً: نجح بـ ON_ERROR_STOP) → ثم verify-rls وجد tenant_isolation=28 بدل 29 لأن **party_balances قشرة تراثية في erp فقط** (0038 أسقطتها؛ التطبيق لا يشير لها؛ صفر صفوف).
8-9. seed/admin bootstrap: seed.ts يولّد كلمة قوية عشوائية مطبوعة مرة واحدة؛ reset-admin-password موجود.
10-13. env/backend/frontend/proxy/SSL: env واضح، لكن لا وثائق نشر إنتاج موحدة.
14-15. backup/restore: JSON-ZIP لكل tenant (admin) + restore-from-backup.mjs (بيانات فقط، يتطلب مخططاً جاهزاً) + pg_dump كامل في backup/.
16. health: /live 200، /ready 503 بلا Redis (سلوك معلن).
**أين سيفشل؟** عند `npm run db:migrate` أولاً، ثم عند غياب Redis، ثم عند عدم تشغيل enable-rls.sql يدوياً.

## 13) Migrations

- journal مكتمل الآن (0001→0043، 43 مدخلاً؛ 0022 تسوية) لكن **migrate فعلياً معطل على قاعدة فارغة** (D-001 ما يزال صحيحاً عملياً — أثبتُّه اليوم).
- المشروع فعلياً يعتمد **db:push** (مثبت مرتين على قواعد جديدة).
- RLS تظهر تلقائياً مع push (enableRLS في المخطط) + سياسات يدوية عبر enable-rls.sql.
- db:push لا يمحو RLS في الحالة الحالية (idempotent — مثبت: push ثانٍ أبقى 38/39).
- baseline/reconciliation: غير مكتمل (party_balances هو الدليل) — Phase B لا يزال مطلوباً.
- production deployment غير آمن حتى يُحل migrate أو يُوثق push+enable-rls.sql كمسار رسمي.

## 14) Backup & Restore

- Backup: POST /api/backup/full (admin، tenant-scoped، ZIP: database.json + uploads) ✅ حي بالكود؛ pg_dump كامل موجود في backup/ (نسخة pre-RLS موثقة ومتحقق استرجاعها سابقاً).
- Restore: restore-from-backup.mjs (بيانات فقط + يتطلب مخططاً)؛ استرجاع pg_dump لا يحتاج أدوات إضافية.
- بعد restore: RLS/السياسات تُسترجع مع الـdump (pg_dump يشملها)؛ roles تُنشأ يدوياً (app_user) — خطوة موثقة ناقصة الأتمتة.

## 15) Security Audit (مختصر بالدليل)

- Argon2id (64MB, t=3, p=4) ✅؛ JWT HS256 pinned + نوع الرمز مُتحقق ✅؛ denylist موصول لكنه **no-op بلا Redis** ❌ (HIGH).
- refresh 30 يوماً **بدون كشف إعادة استخدام** (الرمز القديم يظل صالحاً حتى انتهائه) ⚠️.
- الرمزان في **localStorage** (XSS = سرقة كاملة) ⚠️ (قياسي SPA لكن يجب تقليل نافذة الخطر بـ Redis).
- rate limit: عام + login 5/15min — **بذاكرة العملية** (يعاد ضبطه بالإعادة، لا يعمل متعدد النسخ) ⚠️.
- CORS allowlist + رفض "*" في production ✅؛ helmet ✅؛ trust proxy=1 ✅.
- أخطاء 500 لا تسرب تفاصيل ✅ (رسالة عامة)؛ لكن /auth/me برمز فاسد → **500 بدل 401** (auth.route.ts:77-78) ⚠️.
- Zod strict على الأجسام الحساسة (voucher/invoice schemas في packages/shared) — لا mass assignment ظاهر؛ tenantId دائماً من السياق ✅ (حي).
- مسارات unmatched تحت /api تمر بحارس backup (admin) → 403 بدل 404 لغير الأدمن (تسريب وجود مسار محمي) ⚠️.
- e2e cert suites قديمة (admin/admin) — لا تعمل كما هي ⚠️.
- backend/scripts محملة بسكربتات تشخيص (_tmp، diag-*) — فوضى تشغيلية ⚠️.
- لا SQL injection: كل الاستعلامات drizzle مُعاملة؛ spawnSync في backup بمدخلات خادمية فقط.

## 16-18) الدرجات (مبنية على الدليل أعلاه فقط)

- **Accountant Readiness: 82/100** — كل وظائفه اليومية تعمل حياً (فواتير/سندات/كشوف/ربح/تقارير)؛ ينقصه: لا يستطيع إنشاء الأصناف (تصميم)، لا إدارة مستخدمين له أصلاً (ليست وظيفته)، 500 نادر عند رموز فاسدة، وضع 403 على مسارات خاطئة بدل 404 لا ي affect عمله.
- **Admin Readiness: 72/100** — دعوات/ترخيص/نسخ/audit/إعدادات تعمل؛ **لا يستطيع تعطيل مستخدم إطلاقاً (MISSING)**؛ stale-license خطر تشغيلي؛ إدارة الشركات = على مستوى المنصة فقط.
- **Production Readiness: 42/100** — migrate معطل على قاعدة جديدة؛ Redis غير موجود (خروج لا يعمل)؛ لا HTTPS/proxy ولا وثائق نشر؛ CI بلا RLS ويعتمد migrate المعطل؛ localStorage+refresh طويل بلا تدوير؛ FORCE RLS=0 (مقبول مع عزل app_user لكن يوثق).

## 19) جدول الحالة الحقيقية

| الميزة | تعمل فعلياً؟ | تم اختبارها؟ | دليل | مخاطر | جاهزة للإنتاج؟ |
|---|---|---|---|---|---|
| Login | ✅ | ✅ حي | سيناريو خطوات 1-5 | rate-limit بالذاكرة | ⚠️ |
| Admin | ✅ جزئياً | ✅ حي | مصفوفة الصلاحيات | لا تعطيل مستخدمين | ⚠️ |
| Accountant | ✅ | ✅ حي | 33/34 | — | ✅ |
| Tenant isolation | ✅ | ✅ حي | 39/39 A/B | — | ✅ |
| RLS | ✅ | ✅ حي | كتالوج + 42501 + GUC matrix | FORCE=0 (مقبول) | ✅ |
| Invoice sale | ✅ | ✅ حي | INV-2026-0024 دورة كاملة | — | ✅ |
| Invoice entry | ✅ | ✅ حي | ENT-2026-0029 | — | ✅ |
| Cancellation | ✅ | ✅ حي | إلغاء + استرجاع مخزون 50kg | — | ✅ |
| Payment | ✅ | ✅ حي | VOC-2026-0067 | فجوة partyId ⚠️ | ⚠️ |
| Receipt | ✅ | ✅ حي | VOC-2026-0066 | نفس الفجوة ⚠️ | ⚠️ |
| Inventory | ✅ | ✅ حي | حركات دقيقة 0→50→30→31→50 | لا رؤية color عند إنشاء لفافة ⚠️ | ⚠️ |
| Ledger | ✅ | ✅ حي | 34 قيداً للسيناريو | append-only مفعّل | ✅ |
| Reports | ✅ | ✅ حي | dashboard/profit/statements | — | ✅ |
| License | ✅ | ✅ حي | features/gates/heartbeat | stale findLatest ⚠️، suspended يمر | ⚠️ |
| Invitation | ✅ | ✅ حي | دورة كاملة + ذرية | بلا audit مخصص | ✅ |
| Offline | ✅ (جهاز مستقل) | ⚠️ بالكود | desktop_runtime.rs | لا مزامنة | ⚠️ |
| Online | ✅ local | ✅ حي | خادمان حيان | HTTPS/Redis ناقصان | ⚠️ |
| Backup | ✅ | ✅ بالكود | backup.route + dumps | — | ⚠️ |
| Restore | ⚠️ | ✅ بالكود | restore-from-backup.mjs | يتطلب مخططاً يدوياً | ⚠️ |
| Migrations | ❌ (fresh) | ✅ حي | migrate exit 1 | D-001 | ❌ |
| Deployment | ⚠️ | ✅ حي | push+enable-rls.sql+verify | يدوي جزئياً | ❌ |

## 20) A / B / C / D

**A — جاهز الآن ✅**: الدخول والجلسات (محلياً)؛ دورة المحاسب الكاملة (فواتير بيع/دخول/تعديل/إلغاء، سندات، كشوف، ربح، تقارير، dashboard)؛ عزل المستأجرين على مستوى PostgreSQL (39/39)؛ الترقيم التسلسلي والقيود المزدوجة وحركات المخزون والتدقيق؛ دورة الدعوات الكاملة الذرية؛ بوابات الميزات؛ نسخ احتياطي tenant-ZIP؛ سطح المكتب standalone حقيقي.

**B — يعمل لكن يحتاج إصلاح ⚠️**: الخروج بلا Redis (denylist no-op)؛ refresh بلا كشف إعادة استخدام + localStorage؛ سند بعطية عابرة (partyId) ولفافة بلون عابر (colorId) — تحقق use-case؛ findLatestForTenant بلا فلتر حالة؛ suspended يمر؛ login rate-limit بالذاكرة؛ /auth/me 500 لرمز فاسد؛ 403-بدل-404 عبر حارس backup الاحتياطي؛ e2e suites قديمة؛ فوضى سكربتات التشخيص؛ انحراف PG16/17؛ استرجاع يتطلب مخططاً يدوياً.

**C — غير جاهز ❌**: db:migrate على قاعدة فارغة (معطل فعلياً) — يمنع نشراً نظيفاً ويجعل CI التجهيزي أحمر؛ غياب Redis في الإنتاج (الأمان الجلسات)؛ لا HTTPS/proxy ولا دليل نشر إنتاج موحد؛ CI بلا أي تحقق RLS؛ Phase F غير مكتمل التوصيل (verify-rls موجود ومثبت لكن غير مربوط بـpackage.json/CI، لا apply-rls، لا D-006)؛ لا endpoint لتعطيل المستخدمين؛ party_balances divergence (يجب Phase B).

**D — الخطوة التالية (بالترتيب):**
1. **أمني**: Redis إلزامي في الإنتاج (denylist/خروج) + تدوير refresh مع كشف إعادة الاستخدام + endpoint تعطيل مستخدم + نقل الرموز لـhttpOnly cookie (أو توثيق خطر localStorage وتقصير refresh).
2. **فقد بيانات**: إصلاح db:migrate أو اعتماد push+enable-rls.sql+verify-rls رسمياً (إتمام Phase F: ربط scripts + CI + D-006 + apply-rls.mjs) ثم تسوية party_balances (Phase B).
3. **تعطيل ERP**: تحقق رؤية partyId في السندات وcolorId في اللفائف (سطران في use-cases) + فلتر status في findLatestForTenant.
4. **ترخيص**: توثيق سلوك suspended + قرار grace.
5. **multi-tenant**: (مغطى بـRLS — لا إجراء فوري).
6. **deployment**: nginx/HTTPS + دليل نشر موحد + تشغيل CI أخضر + تنظيف سكربتات التشخيص.

---

## الإجابات المباشرة الاثنتا عشرة

1. **هل أسلّمه لمحاسب اليوم؟** نعم للعمل المحلي اليومي — الدورة الكاملة تعمل حياً (33/34). ليس «جاهزاً» بلا تحفظ: الخروج لا يبطل الرمز بدون Redis، وسندات بعطيات عابرة ممكنة.
2. **Admin يدير Accountant؟** الإنشاء عبر الدعوات ✅ حياً؛ **التعطيل ❌ غير موجود إطلاقاً**.
3. **Accountant فواتير؟** نعم — إنشاء/تعديل/إلغاء بالأرقام الحية، مع صلاحيات صحيحة (ممنوع من الأصناف والأدمن-أونلي).
4. **A معزول عن B؟** نعم على مستوى PostgreSQL نفسها (39/39: 404/0-rows/42501)، مع فجوتي مرجع (سند/لفافة) لا تسربان بيانات.
5. **RLS مفعلة وتعمل؟** نعم: 39 ON، 39 سياسة، app_user NOBYPASSRLS، الختم على كل checkout — مثبتة حياً. FORCE RLS=0 (متعمد).
6. **الترخيص enforced؟** نعم في backend على كل /api (gates حية)؛ ملاحظة: suspended يمر حالياً وخطر stale-license قائم.
7. **دورة الدعوات كاملة؟** نعم حياً: توليد→تحقق→استهلاك ذري→منع إعادة→انتهاء→ربط tenant/role صحيح؛ brute-force غير عملي.
8. **Online على server؟** محلياً/LAN يعمل؛ الإنتاج **لا** — ينقص Redis + HTTPS/proxy + مسار تجهيز موثوق.
9. **Offline حقيقي؟** نعم كجهاز مستقل بذاته (postgres+backend مدمجان، بلا مزامنة — ليست معمارية multi-device).
10. **سيرفر جديد من الصفر؟** ليس بأمر واحد: migrate معطل؛ المسار العملي: push + enable-rls.sql + verify-rls (أثبتُّه) + إنشاء app_user + seed — يتطلب إتمام Phase F أتمتة.
11. **Backup/Restore مثبتان؟** Backup ✅ (ZIP admin-scoped + pg_dump). Restore ⚠️ يعمل بالكود لكنه يتطلب مخططاً جاهزاً ولا يعيد roles تلقائياً.
12. **ما يمنع التسليم/الإنتاج بالضبط؟** (أ) Redis غائب → خروج غير آمن. (ب) migrate معطل → لا تجهيز نظيف/CI. (ج) لا تعطيل مستخدمين. (د) لا HTTPS/نشر. (هـ) Phase F غير مكتمل التوصيل. (و) فجوتا المرجع العابر + stale-license hazard. (ز) Phase B/party_balances.
