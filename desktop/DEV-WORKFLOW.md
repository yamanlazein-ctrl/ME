# DEV-WORKFLOW — دورة التطوير السريع (إجراء دائم)

> القاعدة الذهبية: **لا تبنِ MSI للاختبار أبداً.** بناء الـMSI (خصوصاً `light`
> مع 38 ألف ملف) يستغرق ~ساعة. كل التحقق يتم عبر المسار السريع أدناه
> (دقائق)، ولا يُبنى MSI إلا بتأكيد صريح من المستخدم في كل مرة.

## 1. بروفايل `dev-fast` (الافتراضي لأي اختبار)

```powershell
cd desktop\src-tauri
cargo build --profile dev-fast --offline   # أول مرة ~7 دقائق (كاش جديد)، بعدها ~1-2 دقيقة
```

- معرّف في `desktop/src-tauri/Cargo.toml` (`[profile.dev-fast]`:
  `inherits="dev"`, `opt-level=0`, `debug=false`, `incremental=true`).
- `debug=false` هو التوفير الحقيقي: ربط شجرة Tauri (zstd-sys، blake3، …)
  مع debuginfo يضاعف وقت الربط تقريباً (مشكلة معروفة رسمياً بتقارير Tauri).
- `cargo check` أولاً لأي تعديل صرف (أسرع من البناء).
- `cargo build` العادي (dev بد debuginfo) للتنقيح بالـdebugger فقط عند الحاجة.

> ⚠️ **تعديل `desktop/shell/*.html` (صفحات الغلاف) لا يظهر بعد `cargo build` وحده.**
> `frontendDist` تُضمَّن في exe عبر build-script يكتب نسخته في
> `target\dev-fast\build\motard-fabrics-erp-*\out`، و Cargo لا يعيد بناء ذلك
> المجلد لمجرد تغيّر ملف داخله — حتى `cargo clean -p` لا يحذفه. عند تعديل
> `splash.html` أو `recovery.html` احذف مجلد `build\motard-fabrics-erp-*` أولاً:
>
> ```powershell
> Remove-Item -Recurse -Force target\dev-fast\build\motard-fabrics-erp-*
> cargo build --profile dev-fast --offline
> ```
>
> (تعديلات Rust لا تحتاج هذا — فقط صفحات `shell/`.)

## 2. تشغيل النسخة المبنية مباشرة (بدون MSI)

`tauri-build` ينسخ `resources/` تلقائياً إلى `target/dev-fast/` أثناء البناء،
فالملف الناتج جاهز للتشغيل الفوري:

```powershell
.\target\dev-fast\motard-fabrics-erp.exe
```

- **PR-3 (العزل):** نسخة التطوير (`dev-fast`) تستخدم **`%LOCALAPPDATA%\motard-erp-dev`** منفصلة تمامًا
  (ملف البيانات `data\motard.db` والأنبوب `\\.\pipe\motard-erp-dev`)، فلا تتعارض أبدًا مع نسخة التثبيت التي تستخدم
  `%LOCALAPPDATA%\motard-erp`. يمكن تشغيل النسختين معًا بأمان.
- القياس المعياري: راقب سجل الإقلاع وسطر `listening on pipe` في `server.log` وعنوان النافذة
  (splash = `Motard ERP`، الرئيسية = `Motard Fabrics Group ERP`).

## 3. محاكاة الفشل (اختبار مسارات الخطأ)

```powershell
# احتلال منفذ SSR لإجبار مهلة boot ومراقبة القتل الشامل:
powershell -File $env:TEMP\opencode\hold4173.ps1   # في عملية منفصلة
.\target\dev-fast\motard-fabrics-erp.exe           # انتظر ~120s للحوار المميت
# تحقق: صفر node جديدة + التطبيق حي (الحوار) — ثم OK للخروج (لا خادم قاعدة بيانات: SQLite داخل العملية)
```

## 3.b إشراف العملية المحلية (stack supervisor) — التحقق الحي

بعد الإقلاع، الخادم المحلي تحت إشراف `runtime::supervisor` بخيط مستقل يفحص كل ثانيتين:
هل ما زالت العملية حية؟ وهل لا يزال منفذها يردّ على `/api/health/live`؟

```powershell
# 1) اقتل العملية المحلية أثناء عمل النافذة:
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2) راقب سجل الإقلاع خلال ~10 ثوانٍ — يجب أن تظهر هذه الأسطر بالترتيب:
#      supervisor: the local server process exited (code N) — restarting (attempt 1/5)
#      supervisor: restart attempt 1 — server process <pid> spawned
#      supervisor: restart attempt 1 is serving again on pipe \\.\pipe\motard-erp
#
# 3) النافذة الرئيسية: تُخفى لحظة الموت، ثم تُفتح على نفس العنوان تلقائياً.
#    صفر ظهور لصفحة WebView2 «لا يوجد اتصال بالإنترنت».
```

- عطل دائم في ملف البيانات (مثلاً `data\motard.db` مقفول من عملية غريبة، أو تالف في
  نسخة تجريبية — لا تجرّب ذلك على بيانات حقيقية) يجعل إعادة تشغيل الخادم تفشل في كل
  محاولة؛ بعد خمس محاولات ينتقل التطبيق إلى نافذة الاستعادة الداخلية التي تعرض حالة
  البدء (`LOCKED_UNKNOWN` / `CORRUPT` …) وآخر سطر `[FATAL]` من `server.log` — وهذا هو
  الإجراء الصحيح، لأن سبب الحظر هو البيانات لا الإنترنت.
- **نقرة «إعادة المحاولة»** في نافذة الاستعادة تعطي ميزانية محاولات جديدة فوراً
  (`recovery_retry`).
- سجل فشل العملية محفوظ في `%LOCALAPPDATA%\motard-erp\server.log` ومتاح من
  زر «تفاصيل السجل» في نفس النافذة.

## 4. الروابط السريعة (mold / lld) — الحالة على Windows

- **mold**: لينكس فقط، لا يدعم Windows-MSVC — غير قابل للتطبيق هنا إطلاقاً.
- **lld-link**: غير مثبّت على هذا الجهاز (لا LLVM ولا clang). للتفعيل لاحقاً:
  `winget install LLVM.LLVM` ثم إضافة `.cargo/config.toml` محلي:
  ```toml
  [target.x86_64-pc-windows-msvc]
  linker = "lld-link.exe"
  ```
  (اختياري، يتطلب موافقة — تغيير على مستوى الجهاز/المستودع.)

## 5. بناء MSI النهائي (بتأكيد صريح فقط)

```powershell
cd desktop
npm run tauri:build     # ~ساعة (frontend + release + WiX light) — بتأكيد المستخدم فقط
```

- لا تُشغّله في الخلفية مع اختبارات أخرى (تنافس على القرص/المعالج يشوّه القياسات).
- بعد البناء: استخراج إداري `msiexec /a` للتحقق من النصوص قبل أي تثبيت.
