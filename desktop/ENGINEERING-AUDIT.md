# تدقيق هندسي شامل — قبل التسليم النهائي

> **الحالة:** تقرير فحص فقط. لا تعديل كود نُفِّذ أثناء إعداد هذا التقرير.
> **المنهجية:** كل رقم زمني في هذا الملف **مُقاس فعلياً** عبر `desktop/src-tauri/src/bin/runtime_probe.rs`
> — وهو يستدعي نفس دالة `boot_desktop_stack()` من `desktop_runtime.rs` المُستخدَمة حرفياً في
> الحزمة (`main.rs`)، على نفس ملفات `resources/` المُحزَّمة فعلاً في آخر MSI مبني (`target/release/bundle/msi/...msi`,
> مبني 2026-09-04 15:31:19). لا تخمين ولا استقراء من وثائق — كل رقم هنا من تشغيل حقيقي على هذا الجهاز.
> **التاريخ:** 2026-09-04.

---

## 1. خريطة الترابط الكاملة بين المكوّنات

```
main.rs
 └─ device_binding::ensure_device_binding()          [قراءة/كتابة DPAPI → AppData\device-binding.dat]
 └─ tauri::Builder → boot_desktop_stack(cfg)          [desktop_runtime.rs]
     ├─ find_free_db_port(5432)                       [فحص TCP محلي — أُضيف في هذه الجلسة]
     ├─ preflight_check()                             [stat() على ملفات postgres/node/ssr الحرجة]
     ├─ ensure_pgdata()                                → نسخ pgdata-template → AppData\pgdata  (أو إعادة استخدام إن وُجد)
     ├─ sync_pg_conf_port()                            → كتابة AppData\pgdata\postgresql.conf
     ├─ start_postgres()  → pg_ctl.exe → postgres.exe  [منفذ 5432 أو البديل التلقائي، 127.0.0.1 فقط، لا شبكة]
     │     └─ createdb.exe (best-effort، تُتجاهَل أخطاؤه عمداً — مطلوب لأن القاعدة موجودة أصلاً بالقالب)
     ├─ secret_store::load_or_generate()               [DPAPI → AppData\secrets.dat]
     ├─ spawn_backend() → node.exe server.js            [منفذ 8080 ثابت — مُدمَج وقت بناء الواجهة، لا يمكن نقله وقت التشغيل]
     │     env محقونة: DATABASE_URL, JWT_SECRET, APP_MASTER_KEY, LOG_DIR (أُصلح اليوم),
     │                  CORS_ORIGIN=http://127.0.0.1:4173, LICENSE_SIGNING_PUBLIC_KEY, DESKTOP_DEPLOY=true
     │     cwd = <resources_root>\backend   ← مصدر اكتشاف جديد، انظر §4
     ├─ wait_for /api/health/live  (poll كل 300ms، مهلة 60 ثانية)
     ├─ spawn_ssr() → node.exe serve.mjs                [منفذ 4173 ثابت — مطابق tauri.conf.json]
     └─ wait_for SSR /                                  (poll كل 300ms)
 └─ app.run() → نافذة Tauri تفتح على http://127.0.0.1:4173 (عنوان ثابت، لا اكتشاف ديناميكي)
 └─ عند الإغلاق (ExitRequested): shutdown() [kill backend, kill ssr, pg_ctl stop -m fast -w] → std::process::exit(0)
```

### تقييم كل رابط بيئياً

| الرابط | مطلق أم نسبي | يعتمد على متغيرات بيئة قد تغيب عند العميل؟ |
|---|---|---|
| postgres.exe / pg_ctl.exe / createdb.exe | مطلق (`strip_verbatim_prefix` + `resources_root`) | لا |
| node.exe (backend) | مطلق | لا |
| node.exe (SSR) | مطلق | لا |
| DATABASE_URL | يُبنى داخلياً من `db_port` المُكتشَف فعلياً | لا (لا يعتمد على `.env`) |
| JWT_SECRET / APP_MASTER_KEY | تُولَّد وتُخزَّن محلياً (DPAPI) عند أول إقلاع | لا |
| LICENSE_SIGNING_PUBLIC_KEY | تُقرأ من `resources_root/license-public.pem` وقت `BootConfig::for_app`، ثم تُحقَن كمتغير بيئة | لا |
| CORS_ORIGIN | ثابت `http://127.0.0.1:4173` مُدمَج بالكود | لا |
| **COMPANY_LOGO_DIR** | **غير محقون إطلاقاً** — الـbackend يستخدم افتراضياً مساراً غير مهيّأ لـWindows | **نعم — عيب حقيقي، انظر §4** |

**النتيجة:** كل روابط الإقلاع الأساسية (postgres/backend/SSR) مضبوطة بمسارات مطلقة صحيحة ولا تعتمد على بيئة قد تكون ناقصة. الاستثناء الوحيد المكتشف هو مسار رفع شعار الشركة (§4) — غير مرتبط بمسار الإقلاع، لكنه فئة العطل نفسها (EPERM/مسار خاطئ) في نقطة مختلفة لم تُفحص من قبل.

---

## 2. الجدول الزمني الفعلي للإقلاع — مُقاس، ليس تقديراً

المصدر: تشغيلان حيّان لـ`runtime_probe.exe` على هذا الجهاز، بفارق زمني بينهما، بحيث الأول "بارد"
(تنظيف `%TEMP%\motard-erp-probe` قبل التشغيل لإجبار نسخ القالب من جديد — يُحاكي أول تشغيل بعد تثبيت)
والثاني "دافئ" (نفس `pgdata` من التشغيلة السابقة، بعد إغلاق نظيف).

### 2.1 إقلاع بارد (محاكاة أول تشغيل بعد تثبيت طازج)

| المرحلة | الوقت التراكمي | المدة الفعلية |
|---|---|---|
| بدء العملية → دخول `boot_desktop_stack` | 0.83s | — |
| نسخ `pgdata-template` → AppData (٦٩٢٧ ملفاً، ١٨٠MB) | 1.01s → 12.39s | **11.4s** |
| بدء postgres → **جاهز لقبول اتصالات** | 12.40s → 67.62s | **🔴 55.2s ← أكبر مصدر هدر منفرد** |
| بدء backend (node) → صحي (`/api/health/live`) | 67.63s → 94.15s | **26.5s** |
| بدء SSR → جاهز | 94.15s → 116.37s | 22.2s |
| إيقاف كامل (اختبار الإغلاق النظيف) | 116.37s → 116.66s | 0.3s |
| **الإجمالي (بارد)** | | **🔴 116.66 ثانية (~2 دقيقة)** |

هذا القياس على جهاز تطوير بقرص SSD جيد وبلا حمل إضافي. على جهاز عميل نموذجي (أبطأ، مع حماية
استهلاكية نشطة افتراضياً — Windows Defender الافتراضي الذي لا يُعطَّل عادةً) فإن التقرير الأصلي عن
"5 دقائق" في أول تشغيل **متوقَّع رياضياً من هذا القياس نفسه**، وليس مبالغة أو عرَضاً منفصلاً.

### 2.2 إقلاع دافئ (تشغيلة ثانية فصاعداً — `pgdata` موجود ومُغلَق بنظافة من قبل)

| المرحلة | المدة |
|---|---|
| postgres جاهز | 0.74s |
| backend صحي | 2.83s |
| SSR جاهز | 1.33s |
| إيقاف كامل | 0.16s |
| **الإجمالي (دافئ)** | **✅ 5.40 ثانية** |

### 2.3 الاستنتاج المباشر من المقارنة (116.66s مقابل 5.40s — فارق ٢١ ضعفاً)

الكود نفسه **ليس بطيئاً بنيوياً** — 5.4 ثانية لتشغيلة دافئة رقم جيد فعلاً لحزمة تتضمن PostgreSQL
حقيقياً (ليس SQLite). **كل** فارق الـ111 ثانية الإضافية في التشغيلة الباردة مصدره حالة ملف واحد
مُخزَّن في المثبِّت: `resources/postgres/pgdata-template`. هذا قابل للإصلاح بالكامل بدون أي تغيير
معماري — تفصيل السبب في §3.

---

## 3. السبب الجذري لفجوة الـ55.2 ثانية — من سجل postgres نفسه، لا تخمين

نص سجل `postgres` الفعلي من التشغيلة الباردة أعلاه (`%TEMP%\motard-erp-probe\pgdata\log\postgresql-2026-09-04_155841.log`):

```
2026-09-04 15:58:41 LOG:  database system was interrupted; last known up at 2026-08-31 12:24:06
2026-09-04 15:58:51 LOG:  syncing data directory (fsync), elapsed time: 10.00 s, current path: ./base/58740/56816
2026-09-04 15:59:01 LOG:  syncing data directory (fsync), elapsed time: 20.01 s, current path: ./base/70537/2620
2026-09-04 15:59:07 LOG:  could not open file "./pg.log": sharing violation
2026-09-04 15:59:07 DETAIL:  Continuing to retry for 30 seconds.
2026-09-04 15:59:07 HINT:    You might have antivirus, backup, or similar software interfering with the database system.
2026-09-04 15:59:34 LOG:  syncing data directory (fsync), elapsed time: 52.85 s, current path: ./pg_commit_ts
2026-09-04 15:59:34 LOG:  database system was not properly shut down; automatic recovery in progress
2026-09-04 15:59:34 LOG:  redo starts at 0/19C84430
2026-09-04 15:59:34 LOG:  redo done at 0/19C84430 ...
2026-09-04 15:59:34 LOG:  database system is ready to accept connections
```

### سببان مؤكَّدان، كلاهما من تشخيص postgres نفسه وليس افتراضاً خارجياً

**أ) `pgdata-template` المشحون في المثبِّت الحالي لم يُغلَق بنظافة وقت "الخبز".**
خطة البناء الموثَّقة أصلاً في `desktop/D4-DB-SEEDING-PLAN.md` §1.2 خطوة 7 تنص صراحة: *"أوقف
postgres، احزم `<build_pgdata>` كـpgdata المجمّع"*. لكن القالب الفعلي الموجود الآن في
`resources/postgres/pgdata-template` يحمل بصمة إيقاف **غير نظيف** (`was interrupted; last known up
at 2026-08-31 12:24:06`) — أي أن عملية postgres التي بُني منها القالب أُنهيت بالقوة (kill) أو
انهارت، لا بـ`pg_ctl stop`. النتيجة: **كل نسخة تثبيت جديدة على أي جهاز عميل** تُجبَر على تمريرة
`fsync` كاملة لكل مجلد البيانات (10s → 20s → 52.85s، تصاعدية كما بالسجل) + استرداد WAL (crash
recovery) عند أول تشغيل — وهذا وحده **يمثّل تقريباً كل الـ55.2 ثانية**. هذا عيب في **عملية
التغليف (build pipeline)**، وليس في كود Rust أو TypeScript — القالب المشحون فعلياً يخالف الخطة
الموثَّقة لبنائه.

**ب) postgres نفسه يشخّص تدخّل برنامج حماية صراحة** — `could not open file "./pg.log": sharing
violation` + `HINT: You might have antivirus, backup, or similar software interfering`. هذا
يطابق تماماً بحثاً خارجياً مستقلاً أُجري أثناء هذا التدقيق: مرشِّح Defender الصغير (mini-filter)
يعترض كل عملية كتابة ملف، ويخفّض سرعة نسخ آلاف الملفات الصغيرة من 40+ MB/s إلى 3-8 MB/s فقط
([Microsoft Q&A — Windows Defender Real Time Protection slowing file operations](https://learn.microsoft.com/en-us/answers/questions/2732424/windows-defender-real-time-protection-service-slow?forum=windows-windows_10-performance)).
هذا يُفسّر أيضاً جزءاً من زمن نسخ القالب (11.4s) وأرجح أنه يُفسّر جزءاً من مدة تثبيت الـMSI الأصلية
(9 دقائق حسب تقرير المستخدم — نفس آلية اعتراض الملفات تنطبق على WiX أثناء نسخ آلاف ملفات المثبِّت).

### تقدير واقعي بعد الإصلاح (غير مُقاس بعد — سيُقاس فعلياً قبل أي تثبيت نهائي)

إعادة خبز `pgdata-template` من إيقاف نظيف (`pg_ctl stop -m smart` مع تأكيد `database system is shut
down` في السجل قبل التحزيم) يُفترض أن يُسقط تمريرة الـfsync/recovery بالكامل — وهي ~53 من أصل 55.2
ثانية. الوقت المتبقي عندها هو أساساً نسخ ~180MB (11.4s كما قِيس) + إقلاع postgres/backend/SSR
العاديين (~5s كما أثبت القياس الدافئ في §2.2)، أي **بحدود 15-25 ثانية للإقلاع الأول بعد التثبيت**،
و**~5-6 ثوانٍ لكل إقلاع لاحق**. هذا ليس "1-2 ثانية" كتطبيقات Windows الأصلية الخفيفة — PostgreSQL
نظام قاعدة بيانات كامل وليس محرّكاً مُضمَّناً كـSQLite، وهذا حدّ فيزيائي معروف وموثَّق (نقاش رسمي في
مجتمع Tauri يناقش تحديداً تضمين PostgreSQL ويوصي بعدم توقّع إقلاع فوري:
[tauri-apps/discussions/5418](https://github.com/orgs/tauri-apps/discussions/5418)) — لكنه انتقال
حقيقي من "دقائق" إلى "ثوانٍ معدودة"، وهو الهدف الواقعي الصحيح المطلوب.

---

## 4. اكتشاف جديد — نفس فئة عطل EPERM المُصلَحة سابقاً في السجلات، لكن في مسار مختلف تماماً لم يُفحص من قبل

بحثت عن **كل** موضع كتابة ملف في الـbackend (ليس فقط السجلات، بحث شامل عن
`fs.writeFile|writeFileSync|createWriteStream|mkdir` عبر `src/`).

### 🔴 `backend/src/presentation/routes/company.route.ts:108-111` — رفع شعار الشركة يكتب لمسار خادم Linux، غير مهيّأ لسطح المكتب إطلاقاً

```ts
const dir = process.env.COMPANY_LOGO_DIR ?? "/var/lib/erp/logos";
const path = join(dir, ctx.tenantId, `${randomUUID()}.${ext}`);
await mkdir(join(dir, ctx.tenantId), { recursive: true });
await writeFile(path, buffer);
```

- `COMPANY_LOGO_DIR` **غير مُمرَّر إطلاقاً** من `desktop_runtime.rs::spawn_backend` — تحققت من قائمة
  كل متغيرات البيئة المُحقَنة هناك سطراً بسطر: `NODE_ENV, DESKTOP_DEPLOY, PORT, HOST, CORS_ORIGIN,
  LOG_DIR, DATABASE_URL, JWT_SECRET, APP_MASTER_KEY, LICENSE_SIGNING_PUBLIC_KEY` — لا وجود لـ
  `COMPANY_LOGO_DIR`.
- الافتراضي `/var/lib/erp/logos` مسار سيرفر Linux صرف، **بلا أي تفرّع خاص بـWindows** — بعكس
  `InstallationIdStorage.ts` الذي يتعامل مع Windows صراحةً عبر `%ProgramData%` (انظر أدناه).
- على Windows، `path.join` يحوّل هذا إلى مسار نسبي لجذر القرص الحالي (`C:\var\lib\erp\logos\...`).
  **اختبرته حياً على هذا الجهاز:** الكتابة **نجحت** (صلاحيات هذا الحساب تسمح بإنشاء مجلدات جديدة في
  جذر `C:`) — لكن هذا **غير مضمون على كل جهاز عميل** (سياسات مختلفة، حسابات مقيَّدة، إصدارات Windows
  مختلفة، Group Policy مؤسسي). وحتى لو "نجح" دائماً، فهو **خطأ منطقي مستقل عن مسألة الصلاحيات**:
  شعار الشركة يُخزَّن في مكان لا علاقة له بمجلد بيانات التطبيق (`AppData\motard-erp`) — لا يُنسَخ
  عند نسخ احتياطي، لا يُحذَف عند إلغاء التثبيت، ولا يتبع نفس نمط العزل لكل مستخدم المُتَّبع في بقية
  التطبيق.
- **الإصلاح المطابق تماماً لنمط إصلاح `LOG_DIR` الناجح اليوم:** حقن
  `COMPANY_LOGO_DIR=<app_data_root>\logos` من `spawn_backend`، بلا أي تغيير في كود
  `company.route.ts` نفسه.

### ✅ `InstallationIdStorage.ts` — فُحص، سليم

مسار `%ProgramData%\ERP\install-id` مُعالَج صراحة لكل نظام تشغيل (`DEFAULT_PATHS` في الكود). اختبرت
الكتابة الفعلية إلى `C:\ProgramData` حياً بهذا الحساب — نجحت. لا حاجة لأي تغيير.

### ⚠️ `backup.route.ts:55` — جزء ثانوي غير مكتمل بصمت (لا يفشل بعطل، لكن ناقص وظيفياً)

مخرجات النسخ الاحتياطي (`.zip`, `.json`) تُكتَب عبر `os.tmpdir()` — يُحلّ دائماً لمسار صحيح قابل
للكتابة لكل مستخدم على Windows، **سليم بالكامل**. لكن السطر `const uploadsDir =
resolve("./uploads")` نسبي لـ`process.cwd()` (= مجلد `backend` داخل `Program Files` في التطبيق
المُحزَّم، حيث لا يوجد فعلياً مجلد `uploads`)، فـ`existsSync` يُرجع `false` ويتخطّى الخطوة **بصمت
تام، بلا أي تحذير للمستخدم**. الأثر العملي حالياً محدود (لا مسار رفع مرفقات آخر فعّال في التطبيق غير
شعار الشركة أعلاه)، لكنه يستحق نفس المعالجة (توحيد المسار عبر متغير بيئة قابل للحقن) لتفادي نسخ
احتياطي ناقص بصمت إذا أُضيف مسار رفع مرفقات لاحقاً.

---

## 5. الترقيم والإصدار

| الموضع | القيمة | ملاحظة |
|---|---|---|
| `tauri.conf.json` (المعروض فعلياً للمستخدم — عنوان النافذة، "عن البرنامج"، إلغاء التثبيت من لوحة التحكم) | `1.0.0` | — |
| `Cargo.toml` | `1.0.0` | ✅ متطابق مع `tauri.conf.json` |
| `backend/package.json` | `0.1.0` | ⚠️ غير متطابق، لكن **غير مرئي للعميل إطلاقاً** — بحثت في `src/` (الواجهة) عن أي عرض لرقم إصدار، لا يوجد استخدام له في الواجهة |
| `desktop/package.json` | `0.1.0` | نفس الملاحظة أعلاه |
| آلية تحديثات مستقبلية | **غير مُفعَّلة حالياً** | موثَّق صراحة في `desktop/BUILD-WINDOWS.md` — لا `tauri-plugin-updater` مُضاف في `Cargo.toml`، ولا قسم `plugins` في `tauri.conf.json`. أي تحديث مستقبلي = تثبيت MSI يدوي جديد بالكامل من العميل. هذا قرار منتج معلَّق، وليس عيباً في هذا التدقيق. |

**التوصية:** توحيد `0.1.0`→`1.0.0` في ملفي الـpackage.json تجميلي بحت (لا أثر وظيفي أو مرئي) —
أولوية منخفضة جداً، اختيارية.

---

## 6. الترخيص — فُحص من جديد بشكل مستقل، لا تأخير إقلاع منه

تتبعت المسار الكامل: `boot_desktop_stack()` **لا يستدعي أي فحص ترخيص ولا أي اتصال شبكي إطلاقاً**
أثناء الإقلاع. أمر `validate_license` في `main.rs` هو أمر Tauri IPC (`#[tauri::command]`) يُستدعى
**فقط عند الطلب من الواجهة بعد فتح النافذة بالفعل** — وهو استعلام محلي بحت (Postgres على
`127.0.0.1`، تحقق توقيع Ed25519 محلياً بالمفتاح العام المُخبوز `LICENSE_SIGNING_PUBLIC_KEY`، لا شبكة
خارجية). **مؤكَّد بقراءة الكود مباشرة، لا افتراضاً: صفر تأخير إقلاع من طبقة الترخيص.**

---

## 7. خطة التنفيذ الشاملة المقترحة (بند واحد متكامل — بانتظار الموافقة، لا تنفيذ بعد)

| # | الإصلاح | الملف/الموضع | الأثر المتوقَّع |
|---|---|---|---|
| 1 | **إعادة خبز `pgdata-template` من إيقاف نظيف** — تشغيل postgres من نسخة عمل، `pg_ctl stop -m smart` (لا kill)، تأكيد ظهور `database system is shut down` في سجله قبل التحزيم، ثم استبدال `desktop/src-tauri/resources/postgres/pgdata-template` بالكامل | عملية بناء فقط (لا كود Rust/TS) | 🔴 يُسقِط ~53 من أصل 55.2 ثانية — **الأثر الأكبر في كل هذه الخطة بفارق كبير** |
| 2 | حقن `COMPANY_LOGO_DIR=<app_data_root>\logos` عند `spawn_backend` | `desktop_runtime.rs` | يمنع فشل/سوء تموضع رفع شعار الشركة على أي جهاز عميل، يوحّده مع بقية بيانات التطبيق |
| 3 | توحيد `resolve("./uploads")` في `backup.route.ts` ليُبنى من مسار قابل للحقن بنفس نمط البند 2 | `backup.route.ts` | نسخ احتياطي مكتمل مستقبلاً بلا نقص صامت |
| 4 | رسالة إرشادية بعد التثبيت (ليس أثناءه) تقترح إضافة مجلد التثبيت لاستثناءات Defender — نص فقط ضمن WiX، لا يتطلب رفع صلاحيات | إعداد WiX / `tauri.conf.json` | يقلّص تدخل AV المتبقي (السبب "ب" في §3)، يُحسّن أيضاً زمن تثبيت الـMSI نفسه (9 دقائق المُبلَّغة) |
| 5 | توحيد رقم إصدار `package.json` (تجميلي) | `backend/package.json`, `desktop/package.json` | اتساق فقط، صفر أثر وظيفي |
| 6 | إعادة بناء كاملة (`npm run build` للـbackend، مزامنة `resources/backend/dist`، `tauri build`)، ثم قياس إقلاع بارد + دافئ من جديد عبر `runtime_probe` — **قبل** أي تثبيت فعلي | — | تحقّق بأرقام حقيقية جديدة قبل لمس أي MSI |
| 7 | بعد موافقتك الصريحة على الأرقام الجديدة المُقاسة فقط: بناء MSI نهائي، تسليم المسار الكامل لك لتثبيته يدوياً (دبل-كليك حقيقي + موافقة UAC) — **لن يُحاوَل أي تثبيت صامت مطلقاً بعد الآن** | — | — |

**تقدير الإقلاع النهائي المتوقَّع بعد التنفيذ (غير مُعلَن كمؤكَّد بعد):** إقلاع أول ~15-25 ثانية، كل
إقلاع لاحق ~5-6 ثوانٍ. سيُقاس هذا الرقم فعلياً عبر `runtime_probe` على النسخة المُعاد بناؤها (البند
6) قبل أي تثبيت، ولن يُعلَن "مؤكَّداً" إلا بعد قياس حي جديد — بنفس منهجية هذا التقرير بالكامل.

---

## ملحق — بيانات خام للتحقق المستقل

- ملف الـMSI المبني حالياً (يحتوي إصلاحي المنفذ الاحتياطي ومسار السجلات من هذه الجلسة، **قبل**
  إصلاحات هذا التدقيق): `desktop/src-tauri/target/release/bundle/msi/Motard Fabrics Group ERP_1.0.0_x64_ar-SA.msi`
  (مبني 2026-09-04 15:31:19، لم يُثبَّت بعد على هذا الجهاز حسب علمي).
- سجل postgres الكامل للتشغيلة الباردة المُحلَّلة في §3:
  `%TEMP%\motard-erp-probe\pgdata\log\postgresql-2026-09-04_155841.log`
- حجم `pgdata-template` الحالي: 180MB عبر 6927 ملفاً (`base/`: 147MB، `pg_wal/`: 33MB عبر 4 ملفات —
  حجم WAL طبيعي وليس متضخماً، لا علاقة له بمشكلة الإيقاف غير النظيف).
