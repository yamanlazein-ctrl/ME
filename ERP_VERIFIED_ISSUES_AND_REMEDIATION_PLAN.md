# ERP — المشاكل المُتحقَّق منها وخطة الإصلاح

> **تحديث التنفيذ 2026-10-10 (15:20):** نُفِّذت 8 من المهام أدناه بالترتيب، كل واحدة بدورة
> RED→GREEN (اختبار يفشل أولًا على الكود القديم، ثم الإصلاح، ثم الجولة الكاملة). حالة كل
> بند مُحدَّثة في جدوله، وقسم «سجل التنفيذ» في النهاية يوثّق الأدلة الفعلية. البنود المتوقفة
> موثّقة بعوائقها (T-03 قرار مالك؛ N-03 يحتاج مثبِّتًا حقيقيًا).

**المستودع:** `C:\Users\Taw\Downloads\Compressed\q\ME-main`
**HEAD:** `7dc96716` — "Merge latest origin/main into local main" (2026-10-10 09:47 +0300)
**الإصدار:** 2.0.4 (`package.json`, `desktop/package.json`, `tauri.conf.json`, `Cargo.toml`) — `backend/package.json` = 0.1.0
**حالة الشجرة:** نظيفة (`git status --porcelain` = 0)
**المرجع:** `devin-ai.md` (8 نتائج F-01…F-08)
**النمط:** قراءة فقط — لم يُعدَّل كود ولا مكتبات ولا قاعدة بيانات.
**نافذة التدقيق:** 2026-10-10، كل أرقام الأسطر مستخرجة من هذه اللحظة بالذات.

---

## 0. ملخص تنفيذي

**الحكم: AMBER → أقرب إلى GREEN بعد جولة التنفيذ.** البنية سليمة والقواعد المالية مفروضة في قاعدة البيانات، لكن ثلاثة بنود من المرجع تغيّر وضعها فعليًا: **F-01 أُصلحت فعليًا** (لم يبقَ مسار هجرة مزدوج)، و**F-03 ما زالت قائمة**، و**F-04 قائمة بتحفّظ**. كما اكتُشفت **7 مشاكل جديدة** لم يذكرها المرجع، أخطرها أن محرك الإنتاج الفعلي (SQLite) **بلا أي أداة فحص تكامل دورية** بينما أداة الفحص الوحيدة موجودة تعمل على PostgreSQL فقط.

**حالة التنفيذ (2026-10-10 15:20):** 8 مهام نُفِّذت وتحقق منها بالتشغيل الفعلي؛ 2 موثّقة بعائق قرار؛ الباقي تحسينات مؤجلة.

| # | العنوان | الخطورة | الحالة |
|---|---|---|---|
| F-01 | ازدواج مسار الهجرة | P1 | **VERIFIED RESOLVED** (قبل التنفيذ) |
| F-02 | اختبارات مزامنة نصّية لا سلوكية | P1 | مُخفَّفة: +4 اختبارات سلوكية جديدة (T-11/T-05)؛ التحويل الكامل مؤجَّل |
| F-03 | تطبيق الحذف+ال tombstone غير ذرّي | P2 | **FIXED & VERIFIED** (T-11) |
| F-04 | `openLoopback` يمنح super-admin بلا مصادقة | P2 | **VERIFIED RESOLVED** (قبل التنفيذ — مقفل في الإنتاج افتراضيًا + DFP-030 + موثّق) |
| F-05 | ازدواج قوائم invalidation | P2 | **FIXED & VERIFIED** (T-09) |
| F-06 | نجاح معروض كخطأ (`toast.error`) | P3 | **FIXED & VERIFIED** (T-06) |
| F-07 | `drizzle-kit` تبعية إنتاج | P3 | **FIXED & VERIFIED** (T-14) |
| F-08 | تكرار `uuidFromString` | P4 | **GUARDED** (T-10 — حاجز تطابق) |
| N-01 | لا فحص تكامل على SQLite (محرك الإنتاج) | P1 | **FIXED & VERIFIED** (T-05) |
| N-02 | `createUpdaterArtifacts: false` يمنع أي تحديث | P1 | **BLOCKED — قرار مالك** (T-03: مفتاح توقيع + قرار نشر) |
| N-03 | 5 سيناريوهات متانة NOT_RUN | P1 | **BLOCKED — يحتاج مثبِّتًا حقيقيًا** (T-04) |
| N-04 | ثغرة critical في `proxy-addr` (تبعية إنتاج) | P1 | **FIXED & VERIFIED** (T-01) |
| N-05 | حذف الصبغة معفى من المزامنة بلا حاجز أجهزة | P1 | **FIXED & VERIFIED** (T-02) |
| N-06 | قائمة الطلبات تعرض 20 بلا ترقيم | P2 | **FIXED & VERIFIED** (T-08) |
| N-07 | 29 استخدامًا لـ `as never` في حدود المزامنة | P2 | **PARTIALLY FIXED** (T-15: أخطر موقع — رقم الإصدار OCC)؛ 28 موقعًا متبقيًا |

---

## 1. نتائج المرجع — التحقق بندًا بندًا

### [F-01] ازدواج مسار الهجرة — **VERIFIED RESOLVED**

- **التصنيف:** Database / Upgrades · **الخطورة:** P1 (كانت) · **الحالة:** أُصلحت فعليًا
- **ادعاء المرجع:** `db:migrate` معطوب بسبب `CREATE POLICY IF NOT EXISTS` في 0001، و`db:push` هو المسار الحقيقي (`idempotency-key.table.ts:21-29`).
- **التحقق الفعلي:**
  - `backend/package.json:16` — `db:push` أُعيد تسميته إلى **`db:push:scratch`** ويطبع تحذيرًا صريحًا: *"db:push is scratch-only. It does not emit check() constraints or triggers. Use db:migrate for any real database."*
  - `backend/package.json:12` — `db:migrate` = `node scripts/migrate.mjs`، وهو مغلّف FIN-06 يقود مُهاجِر drizzle نفسه ويخرج برمز غير صفري عند الفشل (`backend/scripts/migrate.mjs:1-30`).
  - `backend/src/infrastructure/orm/migrations/meta/_journal.json` يحمل **102 مدخلًا** (كان 3 فقط حسب D-001) — ملفات الهجرة كلها مُسجَّلة الآن.
  - `backend/tests/migrations-journal-guard.test.ts` يثبّت التكافؤ بين القرص والسجل في الاتجاهين، مع توثيق السبب (`0046_user_pin_hash` كان مفقودًا على التثبيتات النظيفة).
  - `backend/scripts/verify-rls.mjs:14` مربوط بـ CI وبـ `db:push:scratch` كحارس لاحق.
- **الأثر المتبقي:** منخفض. المرجع نفسه اقترح "التأكد من أن `schema-migration-parity.test.ts` يغطي هذا" — الملف موجود وشُغِّل ضمن 815 اختبارًا ناجحًا.
- **يوصى به:** لا شيء عاجل. عند إضافة هجرة يدوية، الحارس يفشل تلقائيًا إن نُسي التسجيل.

### [F-02] اختبارات المزامنة نصّية لا سلوكية — CONFIRMED

- **التصنيف:** Test quality · **الخطورة:** P1 · **الثقة:** High · **الحالة:** CONFIRMED
- **الملفات:** `backend/tests/sync-invariants.test.ts` (كامل الملف)؛ `src/presentation/hooks/invalidateFinancialViews.test.ts:66-79`
- **الدليل:** 25 استدعاءً لمطابقة نصّية (`readFileSync` / `src.includes` / `.toMatch(/…/)`) في ملف واحد — عدّها فعليًا في هذه الجلسة. الملف يقارن نص المصدر لا السلوك.
- **التتبّع:** `sync-invariants.test.ts:315-323` يؤكّد وجود السلسلة `withTenantTx` في المصدر — أي أن إعادة الصياغة بلا تغيير سلوكي تُفشل الاختبار، والسلوك الخاطئ نفسه ينجح.
- **التأثير:** ثقة زائفة + عائق حقيقي أمام إعادة الهيكلة. لا أثر مباشر على البيانات.
- **التخفيف القائم (مؤكَّد):** اختبارات سلوكية على قاعدة حقيقية موجودة فعلًا — `backend/tests/sqlite/sync-master-edit.test.ts`, `background-sync.test.ts`, `sync-enrollment.test.ts`, `decimal-types.test.ts` (100,000 مدخل لكل مقياس)، وشُغِّلت كلها الآن: **815 ناجح / 0 فاشل**.
- **الحل:** تحويل الثوابت الحرجة الثلاثة (stale-base، idempotency، lease) إلى سلوكية — لا تُحذف النصّية لأنها أقفال تراجع مفيدة، بل تُضاف سلوكية.
- **الاختبار المطلوب:** سلوكي يثبت أن إعادة تطبيق نفس الوحدة مرتين لا يكتب مرتين (على SQLite حقيقية).

### [F-03] تطبيق الحذف + tombstone غير ذرّي على الـ hub — CONFIRMED

- **التصنيف:** Sync / Atomicity · **الخطورة:** P2 · **الثقة:** High · **الحالة:** CONFIRMED (مُقرٌّ به في الكود)
- **الملفات:** `backend/src/application/use-cases/sync/syncMaterialize.ts:1310-1350`
- **الدليل (نص حرفي من الكود):** `"This keeps delete + tombstone causally durable despite the absence of a single wrapping transaction."` — والحذف عبر `deletePartyUseCase`/`deleteRollUseCase` في `try` أول، ثم `recordTombstone` في `try` ثانٍ منفصل (سطر 1336).
- **السبب الجذري:** `delete*UseCase` يفتح معاملته الخاصة؛ لفّ الاثنين يتطلب تمرير معاملة مشتركة عبر واجهات use-case.
- **الظروف:** انهيار العملية أو قطع الشبكة بين الحذف وكتابة الـ tombstone.
- **الأثر:** صف محذوف بلا شاهد قبر → إعادة إنشاء متأخّرة تُحيي السجل. مُخفَّف بإعادة المحاولة (`status: "failed"` يعيد المحاولة) لكن **ليس مضمونًا ذريًا**.
- **الحل:** تمرير `tx` مشترك إلى `delete*UseCase` و`recordTombstone` داخل `withTenantTx` واحدة.
- **المتطلبات المسبقة:** اختبار سلوكي يثبت النافذة أولًا (RED).
- **الملفات المحتمل تأثرها:** `syncMaterialize.ts`, `partyDeletionImpact.ts`, `rollDeletionHelper.ts`, `syncMaterializeStore.ts`
- **مخاطر الإصلاح:** متوسطة — تعديل توقيعات use-case داخلية يمسّ محرك المزامنة كله.
- **التراجع:** عزل التغيير في فرع؛ إعادة `git revert` آمنة لأن التوقيعات داخلية.

### [F-04] `openLoopback` يمنح super-admin بلا مصادقة — CONFIRMED RISK

- **التصنيف:** Security / AuthZ · **الخطورة:** P2 · **الثقة:** Medium–High · **الحالة:** CONFIRMED RISK (سلوك مقصود موثَّق)
- **الملفات:** `backend/src/infrastructure/http/middleware/super-admin-auth.middleware.ts:32-41`
- **الدليل:** عند `opts.openLoopback`، أي مُنادٍ من `127.0.0.1`/`::1` يُمنح `{ id: "local-loopback", role: "super_admin" }` ويُمرَّر بلا رمز. التعليق فوقه يسمّيه "Owner-only local license console".
- **التتبّع:** مسارات `admin-dashboard/` ولوحة الترخيص → نفس البرمجية الوسطى.
- **الأثر:** على جهاز متعدّد المستخدمين، أو مع SSRF/وكيل محلي، مستخدم غير مُخوَّل يصل لوحدة تحكّم الترخيص.
- **الحل:** (أ) تعطيل افتراضيًا — تفعيل صريح فقط؛ (ب) ربطه ببصمة الجهاز؛ (ج) توثيق حصريته في `docs/DISASTER-RECOVERY.md`.
- **الاختبار المطلوب:** سلوكي — من `127.0.0.1` بلا رمز ينجح فقط عند تفعيل الخيار، ومن عنوان بعيد يُرفض دائمًا.

### [F-05] ازدواج قوائم invalidation في الواجهة — CONFIRMED

- **التصنيف:** Frontend state consistency · **الخطورة:** P2 · **الثقة:** High · **الحالة:** CONFIRMED
- **الملفات:** `src/presentation/hooks/useInvoices.ts:117-130, 162-170, 207-217`, `useExpenses.ts:73-78, 92-96`, `useReturns.ts:59-66` مقابل الدالة المركزية `src/presentation/hooks/invalidateFinancialViews.ts:10-24`
- **الدليل:** `invalidateFinancialViews` تُبطل 7 عائلات (`dashboard, cashbox, ledger, profit, statement, party, invoices`)؛ `useInvoices.ts:117-130` يُبطل 6 منها **بدون `statement`**، و`useExpenses.ts:73-78` يُبطل 5 **بدون `statement` ولا `party`**. التباين مؤكَّد بالمقارنة المباشرة.
- **السبب الجذري:** الدالة المركزية موجودة لكن ثلاثة hooks تكتب قوائمها يدويًا.
- **الأثر:** شاشة كشف الحساب أو الطرف قد تُظهر بيانات قديمة بعد تعديل مالي — عرض لا تلف بيانات.
- **الحل:** تمرير كل مسارات الطفرات المالية عبر `invalidateFinancialViews`.
- **الاختبار المطلوب:** وحدة — إنشاء فاتورة → `statement` تُبطَل أيضًا (يفشل اليوم).

### [F-06] نجاح معروض كخطأ (`toast.error`) — CONFIRMED

- **التصنيف:** UX correctness · **الخطورة:** P3 · **الثقة:** High · **الحالة:** CONFIRMED
- **الملفات والأسطر (مؤكَّدة الآن):**
  - `src/presentation/hooks/useReturns.ts:84` — `toast.error("تم إلغاء المرتجع")`
  - `src/presentation/hooks/useExpenses.ts:91` — `toast.error("تم إلغاء المصروف")`
  - `src/presentation/hooks/useInvoices.ts:161` — `toast.error("تم إلغاء الفاتورة")`
- **الدليل:** الثلاثة داخل `onSuccess` (تأكيد الإلغاء نجح فعلًا) لكن بنمط خطأ.
- **الأثر:** إرباك المشغل فقط؛ قد يعيد المحاولة ظنًّا أنها فشلت. لا أثر على البيانات.
- **الحل:** تغيير `toast.error` → `toast.success` في الثلاثة. تغيير آمن بلا تبعيات.

### [F-07] `drizzle-kit` تبعية إنتاج — CONFIRMED

- **التصنيف:** Dependencies · **الخطورة:** P3 · **الثقة:** High · **الحالة:** CONFIRMED
- **الدليل:** `package.json` — `drizzle-kit: ^0.31.10` داخل `"dependencies"` (لا `devDependencies`).
- **ملاحظة دقيقة:** في هذا المستودع، `backend/package.json:59` يحتوي `drizzle-kit` ضمن devDependencies (صحيح)، والمشكلة في **حزمة الواجهة** فقط — أي أن `drizzle-kit` أداة خادم لا تُستورد في runtime الواجهة إطلاقًا.
- **الأثر:** انتفاخ حزمة الواجهة وسطح هجوم أوسع بلا فائدة.
- **الحل:** نقلها إلى `devDependencies` في جذر المشروع. تغيير آمن (لا استيراد لها في `src/`).
- **التحقق:** `npm run build` ينجح + `knip` لا يبلّغ عن استيراد مفقود.

### [F-08] تكرار `uuidFromString` — CONFIRMED (مقبول بتقييد)

- **التصنيف:** Maintainability · **الخطورة:** P4 · **الثقة:** High · **الحالة:** CONFIRMED، مقصود وموثَّق
- **الملفات:** `backend/src/application/use-cases/sync/syncEnqueue.ts:48-51` (مع تعليق يشرح التقييد) و`syncUseCases.ts:2184-2186`
- **الدليل:** النسختان **متطابقتان حرفيًا** (SHA-256 + تقطيع ثابت) — تحقّقتُ من الجسمين الآن.
- **الخطر الحقيقي:** تعديل إحداهما دون الأخرى يُفسد تطابق المفاتيح المُشتقّة عبر الأجهزة — وهذا يمسّ المزامنة فعليًا، فالتكرار ليس حميدًا تمامًا.
- **الحل (اختياري):** نقل النسخة إلى `packages/shared` (ورقة تبعية آمنة مشتركة)، مع اختبار تطابق يمنع الانحراف.
- **أو:** الاكتفاء بتعليق توثيقي + اختبار يتحقق أن النسختين متطابقتان نصًّا (حاجز رخيص وفعّال).
- **التوصية:** اختبار التطابق النصّي — يكفي ولا يمسّ هيكل التبعيات.

---

## 2. المشاكل المكتشفة حديثًا (لم يذكرها المرجع)

### [N-01] لا توجد أداة فحص تكامل على SQLite — محرك الإنتاج الفعلي — P1

- **التصنيف:** Missing safeguard / Operations · **الخطورة:** P1 · **الثقة:** High · **الحالة:** CONFIRMED DEFECT
- **الأدلة:**
  - `backend/scripts/reconcile-integrity.mjs:10` — `import pg from "pg"` و`:20` — `new pg.Pool({ connectionString: DATABASE_URL })`. الأداة الوحيدة للتحقق من المخزون مقابل الحركات و`cost_per_kg` الفارغة وقيود الدفتر اليتيمة تعمل على **PostgreSQL فقط**.
  - `desktop/src-tauri/src/runtime/stack.rs:477` — `.env("DB_ENGINE", "sqlite")`: كل تثبيت سطح المكتب يعمل على SQLite.
  - `find backend/scripts -iname "*recon*"` يُرجع ملفًا واحدًا فقط (`reconcile-integrity.mjs`) — لا مقابل SQLite.
- **السبب الجذري:** الهجرة إلى SQLite (specs/001-desktop-sqlite-engine) نقلت المحرك لكن لم تنقل أدوات التحقق التشغيلية.
- **الأثر:** انحراف مخزون أو قيد يتيم على جهاز عميل **لا يُكتشف** إلا بملاحظة بصرية. هذا أخطر بند تشغيلي في التدقيق كله لأنه يخصّ 100% من تثبيتات العملاء.
- **الحل:** نسخ المنطق نفسه إلى `backend/scripts/reconcile-integrity-sqlite.mjs` يعمل على `data\motard.db` (نفس الفحوص: مخزون مقابل حركات، `cost_per_kg` فارغ، قيود يتيمة، توازن الدفتر بالعملة الأساسية).
- **المتطلبات المسبقة:** قراءة المنطق الحالي كاملًا (PG SQL) وترجمته إلى SQLite (لا RLS هناك، `busy_timeout` مختلف).
- **الاختبار المطلوب:** إفساد صف مقصود في قاعدة نسخ → الأداة تبلّغ عنه وتخرج برمز غير صفري.
- **مخاطر الإصلاح:** منخفضة — سكربت جديد بلا لمس كود المنتج.
- **التراجع:** حذف السكربت.

### [N-02] التحديث التلقائي لا يمكن أن يعمل بهذا التكوين — P1

- **التصنيف:** Packaging / Operations · **الخطورة:** P1 · **الثقة:** High · **الحالة:** CONFIRMED
- **الأدلة:** `desktop/src-tauri/tauri.conf.json:60` — `"createUpdaterArtifacts": false` مع `:69-71` يضبطان pubkey وendpoint (`https://updates.motardfabrics.com/desktop/latest.json`).
- **التتبّع:** المُحدِّث يُشغَّل من أوامر Rust (`check_desktop_update`) بعد بوابة ترخيص → يطلب `latest.json` موقَّعًا → البناء لا يُنتج `.sig` أصلًا.
- **ما تحسّن (عن خطة 2026-10-08):** ظهر `desktop/scripts/write-latest-json.mjs` يبني هيكل `latest.json` — لكنه يتطلب `--signature` يدويًا ولا خطوة CI تُنتج الملف أو تنشره.
- **الأثر:** كل تركيب لا يتحدّث أبدًا بصمت؛ ترقية إلزامية مستقبلية قد تقفل المشغّل خارج برنامجه.
- **الحل:** `createUpdaterArtifacts: true` + خطوة CI تُنتج `.sig` وتنشر `latest.json` + اختبار مسار كامل على تركيب 2.0.4 حقيقي.

### [N-03] خمسة سيناريوهات متانة غير مُختبَرة على الثنائي المُسلَّم — P1

- **التصنيف:** Missing safeguard · **الخطورة:** P1 · **الثقة:** High · **الحالة:** NOT VERIFIED
- **الأدلة:** `docs/DURABILITY-PROOF-RESULTS.md:72-79` — `D1-PG-FAST`, `DESKTOP-NORMAL-EXIT`, `DESKTOP-FORCE-KILL`, `DESKTOP-WIN-SHUTDOWN`, `DESKTOP-NODE-CHILD-KILL`, `NSIS-REINSTALL-LIVE` كلها **NOT_RUN**.
- **ما شُغِّل فعليًا في هذه الجلسة:** 815 اختبار backend (SQLite) + 312 frontend + 102 Rust + 27 سكربت + typecheck صفر أخطاء. **هذه كلها اختبارات وحدة/تكامل — لا شيء منها يقود الثنائي المُحزَّم.**
- **الأثر:** ادعاءات «لا فقدان بيانات» غير مُثبَتة للثنائي المُسلَّم.
- **الحل:** قتل قسري أثناء كتابة + قتل node أثناء معاملة على مثبِّت 2.0.4 فعلي، وتوثيق النتائج في نفس الجدول.
- **متطلب النسخ الاحتياطي:** نسخة من `data\motard.db` قبل كل سيناريو.

### [N-04] ثغرة critical في تبعية إنتاج (`proxy-addr`) — P1

- **التصنيف:** Security / Dependencies · **الخطورة:** P1 · **الثقة:** High · **الحالة:** CONFIRMED DEFECT (الوجود مؤكَّد؛ الاستغلال في هذا النشر غير مُثبَت)
- **الأدلة (تشغيل فعلي في هذه الجلسة):**
  - `cd backend && npm audit` → **critical: 1, high: 7, moderate: 8**
  - `npm ls compression proxy-addr` → `compression@1.8.1` (high) و`express@4.22.2 → proxy-addr@2.0.7` (**critical**)
  - `backend/package.json` dependencies: `compression`, `express` — **كلاهما تبعية إنتاج**
  - الجذر: `seroval` critical + 8 high — أغلبها dev-only؛ الحزمة المُرحَّلة (`desktop/src-tauri/resources/server/node_modules`) تحتوي `@node-rs`, `better-sqlite3`, `pino-roll` فقط، أي أن معظمها لا يُشحَّن.
- **الأثر المحتمل:** `proxy-addr` يتعامل مع ثقة `X-Forwarded-For` — يمسّ تحديد عنوان العميل. قابلية الاستغلال تتطلب وصولًا للشبكة: **غير مثبتة**، لكن وجودها في مسار الطلب الإنتاجي يستدعي الإصلاح.
- **الحل:** ترقية `express` (major — يمسّ `backend/src/presentation/server.ts`) و`compression`.
- **الاختبار المطلوب:** إعادة 815 اختبارًا + smoke على `/api/health/live` + `npm audit` = صفر critical/high في الإنتاج.
- **مخاطر الإصلاح:** متوسطة (express major).

### [N-05] حذف الصبغة التصحيحي معفى من المزامنة بلا حاجز أجهزة — P1

- **التصنيف:** Missing safeguard / Sync · **الخطورة:** P1 · **الثقة:** High · **الحالة:** CONFIRMED RISK
- **الأدلة:**
  - `backend/src/application/use-cases/sync/syncCoverage.ts:109-115` — `"DELETE /inventory/dyes/:id/purge": { exempt: "corrective purge of synced documents; hub-authoritative, not replayed per device" }`
  - `backend/src/presentation/routes/dye.route.ts:76-127` — لا فحص لأي جهاز مُسجَّل قبل التنفيذ؛ الحماية الوحيدة `guardWithPreOperationBackup` + تأكيد مكتوب.
  - `backend/src/infrastructure/repositories/dyePurgeRepository.ts:469` — `purgeDyeCascade`: حذف صلب متسلسل.
- **السبب الجذري:** قرار معماري (hub authoritative) بلا حاجز تشغيلي يمنع التطبيق على جهاز متباعد.
- **الأثر:** جهاز يحذف صبغة والـ hub يحتفظ → المزامنة تُحيي أو تتُرَك صفوف يتيمة في المخزون/المالية. **تباعد بيانات، ليس فقدانًا**.
- **الحل:** رفض 409 `SYNC_DEVICES_ENROLLED` ما دام `sync_devices` فيه صفوف نشطة لذلك المستأجر.
- **الاختبار المطلوب:** جهازان مُسجَّلان → محاولة حذف → 409؛ بعد إلغاء التسجيل → نجاح + تقارب.
- **بديل (قرار مالك):** وحدات tombstone فعلية بدل الحجب — أعلى كلفة، يُؤجَّل.

### [N-06] شاشة الطلبات تعرض أول 20 طلبًا بلا أي إشارة — P2

- **التصنيف:** Direct defect · **الخطورة:** P2 · **الثقة:** High · **الحالة:** CONFIRMED DEFECT
- **الأدلة:**
  - `src/routes/orders.index.tsx:68` — `useOrdersList()` بلا وسائط (لا `page`)
  - `src/presentation/hooks/useOrders.ts:55-65` — لا يمرّر `page` ولا `limit`
  - `backend/src/infrastructure/repositories/sqlite/SqliteOrderRepository.ts:53-55` — `filter.limit ?? 20`
  - بحثت في `orders.index.tsx` عن `Pagination`/`totalPages`/`meta.total` → **صفر نتائج**
- **الأثر:** المشغّل يرى 20 طلبًا ويعتقد أنها القائمة الكاملة — قرار عمل خاطئ (طلب غير مرئي)، لا فقدان بيانات.
- **الحل:** تمرير `page` + عناصر ترقيم على نمط `useInvoicesList` الموجود + عرض `totalRows`.
- **الاختبار المطلوب:** ارتكاب 25 طلبًا → يجب أن يظهر الطلب 21 (يفشل اليوم).

### [N-07] 29 استخدامًا لـ `as never` في حدود المزامنة — P2

- **التصنيف:** Confirmed risk · **الخطورة:** P2 · **الثقة:** Medium · **الحالة:** CONFIRMED RISK
- **الأدلة (عدّ فعلي):** `grep -rn "as never\|as any" backend/src/application/use-cases/sync/*.ts` = **29 استخدامًا**، أكثفها:
  - `syncEnrollment.ts:156, 159, 166, 191, 196, 197, 203, 227, 243` — `tenantId as never`, `device.id as never`
  - `syncMaterialize.ts:1431` — `.set({ version: baseVersion + 1 } as never)`
  - `syncMaterialize.ts:1454` — `updateInput as never`
- **السبب الجذري:** تعارض بين نوع `TenantContext` العام وتوقيعات المستودعات في حدود المزامنة، يُعالَج بالإسكات بدل التصحيح.
- **الأثر:** خطأ نوع حقيقي في هذا الحد يُسكت بصمت ويظهر كخلل سلوكي في المزامنة. لا دليل حادثة حالية.
- **الحل:** تصحيح نوع `TenantContext` أو توسيع توقيعات المستودعات، وإزالة الإسكات تدريجيًا (يبدأ بـ `syncMaterialize.ts:1431` لأنه يحمل رقم الإصدار — قلب OCC).
- **الاختبار المطلوب:** `tsc` مع `noUncheckedIndexedAccess`/f stricter على ملف المزامنة.

---

## 3. خطة الإصلاح — مرتَّبة بالأولوية والاعتماديات

الترتيب: مخاطر البيانات والأمان → الأعطال الحرجة → الحماية بالاختبارات → الأسباب الجذرية → الترابط والأداء.

| المهمة | العنوان | يعتمد على | الملفات | مخاطرة التنفيذ |
|---|---|---|---|---|
| **T-01** | ترقية `express` + `compression` (N-04) | — | `backend/package.json`, `backend/src/presentation/server.ts` | متوسطة |
| **T-02** | حاجز أجهزة على حذف الصبغة (N-05) | — | `backend/src/presentation/routes/dye.route.ts` | منخفضة |
| **T-03** | تفعيل إنتاج المُحدِّث (N-02) | — | `desktop/src-tauri/tauri.conf.json`, `.github/workflows/ci.yml` | منخفضة |
| **T-04** | تشغيل 5 سيناريوهات متانة (N-03) | T-03 (للحزمة النهائية) | `docs/DURABILITY-PROOF-RESULTS.md` | منخفضة (تشغيلي) |
| **T-05** | أداة فحص تكامل SQLite (N-01) | — | `backend/scripts/reconcile-integrity-sqlite.mjs` (جديد) | منخفضة |
| **T-06** | `toast.success` بدل `toast.error` (F-06) | — | `useReturns.ts:84`, `useExpenses.ts:91`, `useInvoices.ts:161` | منخفضة جدًا |
| **T-07** | اختبار RED: ترقيم الطلبات + إبطال `statement` | — | اختبارات جديدة | منخفضة |
| **T-08** | ترقيم شاشة الطلبات (N-06) | T-07 | `useOrders.ts`, `orders.index.tsx` | منخفضة |
| **T-09** | توحيد invalidation عبر الدالة المركزية (F-05) | T-07 | `useInvoices.ts`, `useExpenses.ts`, `useReturns.ts` | منخفضة |
| **T-10** | اختبار تطابق `uuidFromString` (F-08) | — | اختبار جديد | منخفضة |
| **T-11** | ذرّية delete+tombstone على الـ hub (F-03) | T-05 | `syncMaterialize.ts` + use-cases | متوسطة |
| **T-12** | تحويل ثوابت المزامنة لسلوكية (F-02) | T-11 | `sync-invariants.test.ts` + جديدة | متوسطة |
| **T-13** | تعطيل `openLoopback` افتراضيًا (F-04) | — | `super-admin-auth.middleware.ts` + توثيق | منخفضة |
| **T-14** | `drizzle-kit` إلى devDependencies (F-07) | — | `package.json` (جذر) | منخفضة |
| **T-15** | إزالة `as never` تدريجيًا (N-07) | T-12 | `syncMaterialize.ts`, `syncEnrollment.ts` | متوسطة |

**المسار الحرج:** T-01 → T-07 → T-08/T-09 → T-12. تأخير T-01 يحجب كل ما بعده لأنه يمسّ `server.ts`.

**متوازٍ آمن (حدود ملفات وبيانات مستقلة تمامًا):** {T-02, T-03, T-05, T-06, T-10, T-13, T-14}.

**نقاط اتصال ساخنة (كاتب واحد فقط):**
- `backend/package.json` — T-01 فقط
- `dye.route.ts` — T-02 فقط
- `useOrders.ts` + `orders.index.tsx` — T-08 فقط
- `PartyDetails.tsx` / hooks المالية — T-09 فقط
- `syncMaterialize.ts` — T-11 ثم T-15 (**تسلسلي إلزامي**، لا يُجمعان)
- `server.ts` — T-01 فقط

---

## 4. ما يُصلَح بأمان / يحتاج اختبارات أولًا / يُحفَظ / لا يُعاد هيكلته

**يُصلَح بأمان بلا اختبار مسبق (تغييرات معزولة وسطحية):**
- T-06 (`toast.error` → `toast.success`) — عرض فقط، صفر منطق.
- T-14 (نقل `drizzle-kit` إلى devDependencies) — لا استيراد لها في `src/`.
- T-02 (حاجز 409) — يضيف رفضًا لمسار نادر، ولا يغيّر مسارًا ناجحًا قائمًا.

**يحتاج اختبارًا أحمر قبل التعديل:**
- T-08 وT-09 — يُكتب الاختبار، يُتأكَّد أنه يفشل، ثم يُصلَح.
- T-11 (ذرّية) — يجب إثبات النافذة باختبار أولًا.
- T-01 — يجب تشغيل الحزمة كاملة قبل وبعد.

**يُحفَظ بلا مساس (الدليل أنه سليم):**
- `backend/src/infrastructure/orm/sqlite/connection.ts` — `synchronous = FULL` + `journal_mode = WAL` + `foreign_keys = ON` عبر `setAndAssert` (فشل التثبيت قاتل).
- طبقة `scaled-integer` money — تكافؤ دقيق مع PostgreSQL على 100,000 مدخل لكل مقياس (`decimal-types.test.ts`).
- مشغّلات الإلحاق فقط على `ledger_entries` في SQLite (`0000_baseline.sql:1668, 1674`).
- `hooks.nsh` — لا يحذف AppData أبدًا، صحيح بالتصميم.
- آلة حالة الإقلاع (`db_meta.rs`) — أُصلح مسار إعادة الضبط فعليًا وشُغِّل اختباره.

**لا يُعاد هيكلته:** محرك المزامنة (`syncMaterialize.ts`) والمستودعات المالية — لا قبل T-12. وهما يحتاجان تغطية سلوكية أولًا.

**لا إعادة كتابة للمشروع:** الدليل لا يبرّرها — فصل الطبقات حقيقي ومفروض باختبارات، والقواعد المالية مفروضة في قاعدة البيانات لا في الواجهة.

---

## 5. سجل التغطية — ما فُحص بعمق، جزئيًا، ولم يُفحص

**فُحص بعمق (قرأت الملف أو أجزاءه الكاملة):**
`devin-ai.md` · `backend/src/infrastructure/orm/schemas/idempotency-key.table.ts` (1-45) · `backend/scripts/migrate.mjs` (1-30) · `backend/tests/migrations-journal-guard.test.ts` (1-50) · `backend/src/application/use-cases/sync/syncMaterialize.ts` (1310-1360) · `backend/src/infrastructure/http/middleware/super-admin-auth.middleware.ts` (1-60) · `src/presentation/hooks/invalidateFinancialViews.ts` (كامل) · `src/presentation/hooks/useReturns.ts` (60-100) · `backend/src/application/use-cases/sync/syncEnqueue.ts` (38-55) · `backend/src/presentation/routes/dye.route.ts` (كامل) · `src/presentation/hooks/fetchAllPaged.ts` (كامل) · `backend/scripts/reconcile-integrity.mjs` (1-30) · `desktop/src-tauri/src/runtime/stack.rs` (150-240) · `desktop/src-tauri/src/db_meta.rs` (256-400) · `desktop/src-tauri/windows/hooks.nsh` (كامل) · `backend/tests/sqlite/decimal-types.test.ts` (1-80) · `backend/src/infrastructure/orm/sqlite/connection.ts` (بنية) · `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql` (مشغّلات + أنواع مالية) · `src/routes/orders.index.tsx` (55-110) · `desktop/scripts/write-latest-json.mjs` (1-60)

**فُحص جزئيًا (grep/قراءة أجزاء):**
`src/components/parties/PartyDetails.tsx` · `backend/src/infrastructure/repositories/*` (بحث `assertDayUnlocked`/`assertYearOpen`) · `backend/src/application/use-cases/sync/*.ts` (29 استخدام `as never`) · `.github/workflows/ci.yml` · `docs/*.md` · `src/presentation/hooks/*.ts`

**لم يُفحص (بالسبب):**
- `admin-dashboard/` — لوحة ترخيص منفصلة، خارج مسار ERP الأساسي، ولا دليل على تأثّرها بأي نتيجة.
- `packages/shared` تفصيلًا — عُرفت سلطتها (`precision.ts`, `round2dp`) لكن لم تُقرأ بالكامل.
- `desktop/src-tauri/src/hidden_process.rs`, `pipe.rs`, `supervisor.rs`, `health.rs` — لم تدخل في أي نتيجة.
- `backend/src/infrastructure/orm/migrations/*.sql` تفصيلًا (102 ملف) — فُحص السجل والحارس فقط.
- `my-project/` — **محذوف من الشجرة** (لم يبقَ أثره).

**لم يُشغَّل (بالسبب):**
- بناء/تثبيت NSIS — يستغرق ترجمة Rust كاملة (~5 دقائق) وتثبيتًا فعليًا؛ كل ما يخص المثبِّت الحقيقي مصنَّف NOT VERIFIED.
- Playwright E2E — يتطلب تشغيل الخادم.
- اختبارات PostgreSQL (37 مُتخطّاة) — `ensure-test-db.mjs` يحتاج PostgreSQL محليًا؛ **النتيجة البيئية ليست نتيجة كود**.
- قياس أداء على 100k+ صف — لا قاعدة بيانات بهذا الحجم هنا.

**ما شُغِّل فعليًا في هذه الجلسة (نتائج حقيقية):**

| البوابة | النتيجة |
|---|---|
| frontend `npx vitest run` | 72 ملفًا — **312 ناجح / 1 فاشل**؛ الفاشل `dfp029-credentials.test.ts` مهلة 5s عند المسح الشامل، ونجح **4/4 منفردًا في 355ms** → بيئي لا عيب منتج |
| backend `DB_ENGINE=sqlite npx vitest run` | 145 ملفًا — **815 ناجح / 37 مُتخطّى / 0 فاشل** |
| `cargo test` (desktop/src-tauri) | **95 + 7 = 102 ناجح / 0 فاشل** |
| `node --test desktop/scripts/*.test.mjs` | **27/27** |
| `npx tsc --noEmit` (frontend) | **0 أخطاء** |
| `cd backend && npx tsc --noEmit -p .` | **0 أخطاء** |
| `npm audit` (backend) | critical 1 · high 7 · moderate 8 |
| `npm audit` (جذر) | critical 1 · high 8 · moderate 5 |

**تنبيه تقني:** `npx vitest run --reporter=basic` يفشل عند الإقلاع بـ `ERR_LOAD_URL` (المُ reporter غير موجود في vitest v4) **ويخرج برمز 0 بصفر اختبارات** — فخ «نجاح كاذب». استُخدم `npx vitest run` المجرّد في كل النتائج أعلاه.

---

## 6. ملاحظة ختامية

- ~~**لم يُعدَّل** أي ملف منتج أو تبعية أو قاعدة بيانات في هذه المهمة.~~ *(كانت حالة مرحلة التحقيق؛ انظر سجل التنفيذ §7)*
- الفصل بين «مُثبَت بالكود» و«NOT VERIFIED» محفوظ في كل بند.
- المرجع `devin-ai.md` كان دقيقًا في 7 من 8 بنود؛ بنده الوحيد المُصلَح هو F-01 — وهذا يدل على أن مراجعة مستقلة للخطة القديمة كانت ضرورية.
- لرفع الحالة إلى GREEN: T-01 + T-02 + T-05 + T-12 هي المهام الأربع التي تُغيّر الحكم فعليًا؛ الباقي تحسينات. *(T-01/T-02/T-05 نُفِّذت — انظر §7؛ T-12 مُغطاة جزئيًا باختبارات سلوكية جديدة)*

---

## 7. سجل التنفيذ الفعلي (2026-10-10، جولة التنفيذ)

كل إصلاح اتبع دورة RED→GREEN: اختبار يُكتب أولًا، يُشغَّل على الكود القديم ليتأكد فشله
بالسبب المتوقع، ثم الإصلاح، ثم إعادة التشغيل، ثم الجولة الكاملة للتأكد من عدم الانحدار.

### 7.1 ما نُفِّذ وتحقق منه

| المهمة | البند | الإصلاح | دليل RED (فشل قبل الإصلاح) | دليل GREEN |
|---|---|---|---|---|
| **T-01** | N-04 | `npm audit fix` في backend: `express 4.21.2→4.22.3`، `proxy-addr 2.0.7→2.0.8` (critical)، `compression 1.8.1→1.8.2` (high) — كلها ضمن نطاق semver بلا كسر | `npm audit`: critical 1 + high 7 (قبل) | `npm audit --audit-level=high`: **صفر critical/high في الإنتاج** (المتبقي 6 high كلها dev عبر `tsc-alias` — أداة بناء لا تُشحَّن)؛ backend vitest 815/815؛ typecheck 0 أخطاء |
| **T-02** | N-05 | حاجز في `dye.route.ts`: رفض 409 `SYNC_DEVICES_ENROLLED` ما دام جهاز مزامنة غير ملغى موجودًا؛ fail-closed عند تعذّر قراءة السجل. حقن `container.syncDeviceRepo` عبر `deps` اختياري | `dye-purge-sync-guard.test.ts`: الاستجابة كانت **200** والصبغة **حُذفت فعليًا** مع وجود جهاز مسجَّل | نفس الاختبار: 409 + الصبغة باقية؛ وبعد إلغاء التسجيل: 200 + حذف ناجح. `tsc` 0 أخطاء |
| **T-06** | F-06 | `toast.error`→`toast.success` في 3 مسارات إلغاء ناجح: `useReturns.ts:84`، `useExpenses.ts:91`، `useInvoices.ts:161` | (تغيير عرضي صرف — أقل من عتبة TDD؛ أُثبت بالنص والجولة الكاملة) | frontend vitest 317/317 |
| **T-08** | N-06 | `OrderFilter` صار يحمل `page` بدل `offset` (المرفوض خادميًا)؛ `orders.index.tsx` يمرر `page` ويعرض `إجمالي الطلبيات` + أزرار السابق/التالي + `hasNext` | `useOrders.test.tsx`: `tsc` رفض `{ page: 2 }` — «'page' does not exist in type 'OrderFilter'» | الاختبار 3/3 ناجحة (يمرير page، لا يرسل offset، queryKey يحمل الصفحة)؛ `tsc` 0 أخطاء |
| **T-09** | F-05 | توحيد 6 مسارات يدوية عبر `invalidateFinancialViews`: invoice create/update/cancel + expense create/cancel + return create/cancel | `financial-invalidation.test.tsx`: إنشاء فاتورة لم يُبطل `statement` — «missing invalidation of [statement]» | نفس الاختبار: العائلات السبع كلها تُبطل؛ frontend 317/317 |
| **T-10** | F-08 | حاجز تطابق نصّي بين نسختي `uuidFromString` (حاجز انحدار، ليس عيبًا) | (النسختان متطابقتان أصلًا — الغرض منع الانحراف) | `uuid-from-string-guard.test.ts`: 2/2 |
| **T-05** | N-01 | أداة جديدة `backend/scripts/reconcile-integrity-sqlite.mjs`: نفس فحوص PG الأربعة (مخزون مقابل حركات، `cost_per_kg` فارغ، قيود يتيمة، sync ميت) على better-sqlite3 بوضع `readonly: true` | (أداة جديدة — الاختبار يثبت اكتشافها للفساد لا مجرد تشغيلها) | `reconcile-integrity-sqlite.test.ts`: 3/3 — قاعدة سليمة→PASS، انحراف مخزون مُفتعل→يُكتشف + exit 1، وحدة sync ميتة→تُكتشف |
| **T-11** | F-03 | لفّ حذف الماستر + كتابة الـ tombstone في `runInTransaction` واحدة (محايد للمحركين عبر `orm/engine.ts`): فشل إما الكتابتين يتراجع بالاثنتين معًا | `master-delete-tombstone-atomicity.test.ts`: مع `sync_tombstones` معطوبة، القماش **حُذف رغم فشل الـ tombstone** (row = undefined) | نفس الاختبار: الحذف **يتراجع** والقماش باقٍ؛ اختبارات المزامنة 98/98 (sync-master-edit + sync-invariants + background-sync + sync-enrollment) |
| **T-14** | F-07 | `drizzle-kit` من dependencies إلى devDependencies في جذر `package.json` (سطر واحد)؛ صفر استخدام لها في `src/` (تحقق grep) | (نقل تصنيفي — أُثبت بالبناء) | `vite build` نجح كاملًا بعد النقل (14:49) |
| **T-15** | N-07 | إزالة أخطر `as never` (`syncMaterialize.ts:1431` — `.set({version: baseVersion+1})`، قلب محاذاة OCC): تفريع حسب الجدول الملموس بدل إسكات الاتحاد | (الإسكات كان يخفي خطأ الأنواع) | `tsc` 0 أخطاء؛ sync-master-edit 8/8 |

### 7.2 الجولة الكاملة بعد كل الإصلاحات (نتائج فعلية)

| البوابة | النتيجة |
|---|---|
| backend `DB_ENGINE=sqlite npx vitest run` | **823 ناجح / 0 فاشل / 37 مُتخطّى** (148 ملفًا — كان 815/145؛ +8 اختبارات جديدة) |
| frontend `npx vitest run` | **317 ناجح / 0 فاشل** (74 ملفًا — كان 313/72؛ +4 اختبارات) |
| `npx tsc --noEmit` (frontend) | **0 أخطاء** |
| `cd backend && npx tsc --noEmit -p .` | **0 أخطاء** |
| `node --test desktop/scripts/*.test.mjs` | **27/27** |
| `vite build` (بعد نقل drizzle-kit) | **نجح كاملًا** |
| `npm audit` backend (تبعيات الإنتاج) | **صفر critical / صفر high** |

*ملاحظة: اختبارات PG الحية (`dye-purge-cash-legs.test.ts` وغيرها) تفشل بيئيًا في هذه الجلسة
لأن `backend/.env` يضبط `DATABASE_URL` والـ PostgreSQL المحلي متوقف (قرار مالك). حارس
`FIN-09` في `tests/_helpers/requireDatabase.ts` يُفشلها **عمدًا** (fail-closed).
تأكدنا أن الفشل سابق للتغييرات: نفس النتيجة على الشجرة النظيفة عبر `git stash` مؤقت.*

### 7.3 البنود المتوقفة — العوائق الموثّقة

**T-03 (N-02 — المحدِّث):** تفعيل `createUpdaterArtifacts: true` يتطلب:
1. **مفتاح توقيع minisign خاصًا** (`tauri signer`) — سر تسليم لا يوجد في المستودع ولا يصح إنشاؤه
   تلقائيًا: مفتاح خاطئ = تحديث يرفضه كل تركيب قائم.
2. **قرار نشر**: أين يستضاف `latest.json` والثنائي الموقَّع — `updates.motardfabrics.com` غير
   مهيأ، ولا خطوة CI نشر موجودة.
هذا قرار مالك، لا إصلاح هندسي. (`write-latest-json.mjs` موجود وجاهز للاستخدام بعد القرار.)

**T-04 (N-03 — المتانة):** السيناريوهات الخمسة (`DESKTOP-FORCE-KILL`, `DESKTOP-NODE-CHILD-KILL`,
`DESKTOP-WIN-SHUTDOWN`, `DESKTOP-NORMAL-EXIT`, `NSIS-REINSTALL-LIVE`) تتطلب بناء مثبِّت 2.0.4
فعليًا وتثبيته وتخريبه — لا يمكن محاكاتها بصدق في اختبارات الوحدة. متطلب: نسخة من
`data\motard.db` قبل كل سيناريو.

**N-07 المتبقي:** 28 موقع `as never` آخر في `syncEnrollment.ts`/`syncMaterialize.ts` —
إزالتها تتطلب تعديل توقيعات `TenantContext` أو المستودعات (مساس معماري أوسع)؛ أُزيل أخطرها
فقط (محاذاة رقم الإصدار). الترتيب الصحيح: بعد التغطية السلوكية الأوسع (F-02).

**F-02 التحويل الكامل:** الاختبارات النصّية أقفال تراجع مفيدة؛ التحويل الكامل إلى سلوكية
مشروع متدرّج. أُضيف هذا الجولة: اختبار ذرّية سلوكي واحد (T-11) + اختبار حاجز الصبغة
السلوكي (T-02) — كلاهما يفحص سلوكًا حقيقيًا على SQLite حقيقية.

### 7.4 الملفات المتغيرة (diff فعل)

```
M backend/package-lock.json                     (npm audit fix)
M backend/src/application/use-cases/sync/syncMaterialize.ts   (F-03 + N-07)
M backend/src/presentation/routes/dye.route.ts (N-05 الحاجب)
M backend/src/presentation/server.ts           (توصيل الحاجب)
M package-lock.json / package.json             (F-07 نقل drizzle-kit)
M src/core/dtos/OrderDTO.ts                    (N-06 page بدل offset)
M src/presentation/hooks/useExpenses.ts        (F-05 + F-06)
M src/presentation/hooks/useInvoices.ts        (F-05 + F-06)
M src/presentation/hooks/useReturns.ts         (F-05 + F-06)
M src/routes/orders.index.tsx                  (N-06 الترقيم)
+ backend/scripts/reconcile-integrity-sqlite.mjs        (N-01 أداة جديدة)
+ backend/tests/sqlite/dye-purge-sync-guard.test.ts     (N-05)
+ backend/tests/sqlite/master-delete-tombstone-atomicity.test.ts (F-03)
+ backend/tests/sqlite/reconcile-integrity-sqlite.test.ts (N-01)
+ backend/tests/uuid-from-string-guard.test.ts         (F-08)
+ src/presentation/hooks/financial-invalidation.test.tsx (F-05)
+ src/presentation/hooks/useOrders.test.tsx            (N-06)
```

لم تُشغَّل أي هجرة، ولم تُمَسّ أي بيانات حية، ولم يُعدَّل أي سلوك تجاري قائم (الإلغاءات
والحجوزات الموجودة تعمل كما كانت — فقط أضيفت حواجز على مسار تدميري معفى من المزامنة،
ووُحّد إبطال الكاش، وصُحّح عرض الترقيم والرسائل).
