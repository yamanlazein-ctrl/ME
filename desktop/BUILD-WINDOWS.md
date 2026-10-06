# بناء تطبيق Windows — Motard Fabrics Group ERP

نسخة سطح المكتب = **غلاف Tauri رفيع** + **خادم Node واحد** (API + محرّك قاعدة البيانات **SQLite المضمَّن**).
لا خادم قاعدة بيانات، ولا SSR، ولا أي منفذ TCP. (specs/001-desktop-sqlite-engine؛ الخادم المركزي/السحابي يبقى على PostgreSQL.)
القرار المعماري وأسبابه: `docs/decisions.md` (ADR-DESKTOP-2026) و`specs/001-desktop-sqlite-engine/plan.md`.

## الهيكل وقت التشغيل

```
Tauri shell (Rust)  ──starts──►  Node 22: server.mjs  (أنبوب مسمّى: \\.\pipe\motard-erp — بلا TCP)
        │                             ├─ /api/*            الـ API
        │                             └─ SQLite (better-sqlite3)  %LOCALAPPDATA%\motard-erp\data\motard.db
        └─ نافذة WebView2 تُنشأ بعد أن يجيب الأنبوب على /api/health/live
```

- قبل أي تشغيل: قفل مجلد البيانات `motard.lock` (حصري طوال عمر العملية) ثم قرار البدء من الملفات فقط:
  **FRESH** (مجلد فارغ ← يُنشأ `motard.db` من هجرات SQLite المرفقة + `desktop-seed.json`)، أو **REUSE** (قاعدة موجودة
  وهوية `db-meta.json` ومعرّف التثبيت في HKCU متطابقة)، وإلا **توقّف آمن** دون تغيير أي ملف (تثبيت جديد فوق بيانات سابقة،
  ملف مفقود رغم وجود دليل على بيانات، مخطط أحدث من البرنامج، بيانات PostgreSQL قديمة).
- إعادة التشغيل التلقائي للخادم: 3 محاولات كحد أقصى خلال أي 5 دقائق، ثم «توقفت الخدمة الداخلية» ونافذة الاسترداد.
- الانتظار مبني على حياة العملية (جاهز ← تابع، مات ← فشل فوراً برمز الخروج وآخر سطور السجل، حيّ لكن بطيء ← استمر
  وأظهر الوقت المنقضي). لا مهل قصيرة تحوّل «بطيء» إلى «خطأ».
- ربط الجهاز: بصمة واحدة ثابتة (`MachineGuid`). تغيّرها لا يوقف التطبيق؛ الحماية من النسخ هي تشفير DPAPI لكل مستخدم.
- نسخة واحدة فقط تعمل لكل مستخدم (single-instance).

## المتطلبات

1. Windows 10/11 x64
2. Rust + Cargo (`x86_64-pc-windows-msvc`) + Visual Studio Build Tools (C++)
3. Node.js 22+
4. اتصال بالإنترنت أول بناء (تنزيل NSIS ومكتبات Rust)

## البناء

```powershell
cd desktop
npm install
# متغيرات البيئة (لا تُخزَّن في الريبو):
#   DESKTOP_LICENSE_KEY     اختياري: LIC-DESKTOP-… (الافتراضي عشوائي)
#   BAKED_LICENSE_DEVICES   اختياري: عدد الأجهزة في الترخيص المخبوز (الافتراضي 1)
#   مفتاح توقيع الترخيص: LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY أو backend\.env
# لا توجد DESKTOP_ADMIN_PASSWORD: محتوى أول تشغيل (desktop-seed.json) بلا أي حساب مدير،
# والمستخدم ينشئ الرمز السري عند أول تشغيل من شاشة الإعداد (4 أرقام، تُخزَّن Argon2 hash فقط).
npm run tauri:release
```

> **استخدم `tauri:release` وليس `npx tauri build` مباشرةً.** بعد البناء توجد **ثلاث** نسخ من الموارد
> المُحزَّمة: `resources\` (ما يحزمه tauri)، و`target\release\` (ما يحمّله الملف التنفيذي وقت التشغيل)،
> ونسخة الواجهة **مضمَّنة داخل الملف التنفيذي** وقت الترجمة. بناء ناقص يترك الثلاث متعارضة، وأثره
> أن الزبون يشغّل «النسخة الجديدة» فيرى السلوك القديم. `tauri:release` يضيف بعد `tauri build` بوابة
> `verify-build-freshness.mjs post` التي تثبت: تطابق `target\release` مع `resources` بايت-ببايت، وأن
> الملف التنفيذي **يضمّن** أصول الواجهة الحالية، وأن المثبّت موجود وأحدث من الملف التنفيذي.


`before-build.cmd` ينفّذ بالترتيب، وأي فشل يوقف البناء:

1. `stage-node-runtime.mjs` — node.exe المحمول (مثبّت الإصدار).
2. `build-frontend.cmd` — واجهة SPA (`VITE_DESKTOP_DEPLOY=true`) ← `resources/server/web`.
3. `bundle-server.mjs` — الباك-إند كملف واحد بـesbuild + عمّال pino + argon2 الأصلي + **better-sqlite3 (win32-x64)**
   + هجرات SQLite ← `resources/server` (حوالي 230 ملفاً).
4. `build-desktop-seed.mjs` — محتوى أول تشغيل `resources/server/desktop-seed.json`: **المستأجر الافتراضي + الترخيص الموقّع
   فقط (بلا مستخدمين)**؛ يتحقق أن `license-public.pem` المرفق هو زوج مفتاح التوقيع.
5. `server-bundle.test.mjs` — تشغيل حقيقي للخادم المُحزَّم بـnode.exe المرفق على SQLite من مجلد فارغ (FRESH)، ثم REUSE،
   ورفض تثبيت جديد دون تغيير الملف، وأن الخادم لا يحجز أي منفذ TCP (مع احتلال 8080 و4173 عمداً).
6. `validate-resource-manifest.mjs` — كل ملف تشغيل مطلوب موجود وغير فارغ، ومحرّك SQLite المرفق يُحمَّل فعلاً بـnode.exe
   المرفق (بدقة أعداد 64-بت)، ولا أثر لـPostgreSQL.
7. `verify-no-postgres.mjs` — لا `postgres.exe` ولا `pg_ctl.exe` ولا `initdb.exe` ولا `pg_dump.exe` ولا `libpq*.dll`
   ولا `pgdata-template` ولا `db-port.txt` في أي مكان من الحزمة (SC-002). يعمل أيضاً على نسخة قيد التشغيل: `--pid <pid>`.
8. `verify-build-freshness.mjs pre` — بوابة النضارة: الباك-إند والواجهة المُحزَّمان ** أحدث ** من كل
   ملف مصدر، وأن كل أصل تشير إليه صفحة الغلاف موجود، ولا بقايا لقطع بناء قديمة. قبل هذه البوابة كان
   البناء يترجم شجرة موارد أقدم من المصدر دون أن يفشل، فيشحن التطبيق واجهة قديمة.

## المخرجات

`desktop/src-tauri/target/release/bundle/nsis/*-setup.exe` — مثبّت **لكل مستخدم** (`installMode: currentUser`):
لا يطلب صلاحيات مدير ولا UAC، ولا يستخدم MSI (MSI يسجّل كل ملف ويحفظ نسخة تراجع له، وهذا ما جعل التثبيت
القديم يتجاوز 10 دقائق). التثبيت الصامت: `Motard...-setup.exe /S`.

## بيانات المستخدم

`%LOCALAPPDATA%\motard-erp\` (قاعدة البيانات `data\motard.db`، هويتها `db-meta.json`، `secrets.dat`، `backups\`،
`server.log`، `logs\`). إلغاء التثبيت العادي **لا** يحذفها، ويحذف فقط معرّف التثبيت من HKCU؛ لذلك يرى التثبيت الجديد
البيانات السابقة ولا يستخدمها تلقائياً أبداً: يتوقف بأمان على حالة البدء `PRIOR_DATA_FOUND` ويعرض «افتح الموجود /
استعادة نسخة احتياطية / ابدأ مشروعاً جديداً» («ابدأ جديداً» ينقل البيانات إلى `set-aside\<وقت>` ولا يحذفها). التحديث من داخل
التطبيق يعيد فتح البيانات نفسها بلا سؤال (`REUSE` عبر `pending-update.json`). باقي الحالات (`MISMATCH`، `CORRUPT`، `TOO_NEW`،
`DATA_MISSING`، `LOCKED_UNKNOWN`، `SERVICE_STOPPED`) وخياراتها في `specs/001-desktop-sqlite-engine/contracts/data-root-and-startup-states.md`.
النسخ الاحتياطية بصيغة **v3** (ZIP يحوي قاعدة SQLite مفحوصة + manifest): تلقائية كل 24 ساعة (آخر 7 في `backups\` ونسخة في
`المستندات\Motard ERP Backups`)، وقبل كل تحديث/ترقية/حذف نهائي/استرجاع، وكلها تُفحص قبل اعتمادها. الاسترجاع يفحص النسخة
ويأخذ نسخة أمان ويرقّي نسخة مؤقتة ويقارن الأرقام (RS-5) قبل الاستبدال الذري؛ نسخ عصر PostgreSQL (v2) تُرفض برسالة صريحة.
الاسترجاع على جهاز مُزامَن يعطيه هوية مزامنة جديدة ويجلب الأحدث من المركز قبل أي إرسال (`docs/DISASTER-RECOVERY.md`).
إعادة البدء من الصفر إجراء متعمَّد من داخل التطبيق («إعادة الضبط المصنعي» — ينقل `data` جانباً إلى `data.reset-*`
ولا يحذف شيئاً). بيانات إصدار PostgreSQL السابق (`pgdata`) لا تُنقل ولا تُحذف: يتوقف البرنامج بأمان ويطلب نسخة احتياطية. المسار الفعلي معروض داخل
التطبيق في **الإعدادات ← بيانات هذا التثبيت** مع وسم `DEV BUILD` لأي نسخة تطوير.

**عزل Release عن Dev:** أي بناء بـ`debug_assertions` (كل ما ليس `release`، بما فيه `dev-fast`) يستعمل
جذراً وأنبوباً مختلفين تماماً: `%LOCALAPPDATA%\motard-erp-dev` و`\\.\pipe\motard-erp-dev`. لذا لا يمكن
لبناء تطوير أن يفتح قاعدة زبون، ولا يمكن لنسخة مثبَّتة أن ترى بيانات التطوير. الخيار نفسه في Rust
(`DATA_ROOT_DIR_NAME`) و`PIPE_PATH` مربوطان باختبار وحدة يمنع أي انفصال بينهما.

## تسريع أول تشغيل: استثناء Windows Defender (اختياري)

الفحص الآني لآلاف الملفات هو أكبر عامل بطء في أول تشغيل. الحزمة الآن أقل من 6 آلاف ملف بدل 33 ألفاً، لكن
يمكن للمسؤول إضافة مجلد التثبيت `%LOCALAPPDATA%\Programs\Motard Fabrics Group ERP` ومجلد البيانات
`%LOCALAPPDATA%\motard-erp` إلى الاستثناءات (Windows Security ← Exclusions). لا يفعل المثبّت ذلك تلقائياً.
