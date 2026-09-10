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

## 2. تشغيل النسخة المبنية مباشرة (بدون MSI)

`tauri-build` ينسخ `resources/` تلقائياً إلى `target/dev-fast/` أثناء البناء،
فالملف الناتج جاهز للتشغيل الفوري:

```powershell
.\target\dev-fast\motard-fabrics-erp.exe
```

- يستخدم **نفس** `%LOCALAPPDATA%\motard-erp` (نفس pgdata والمنفذ المحفوظ
  `db-port.txt`) — لا تزامن إضافي لازم.
- القياس المعياري: راقب `8080/api/health/live` و`4173/__health` وعنوان النافذة
  (splash = `Motard ERP`، الرئيسية = `Motard Fabrics Group ERP`).

## 3. محاكاة الفشل (اختبار مسارات الخطأ)

```powershell
# احتلال منفذ SSR لإجبار مهلة boot ومراقبة القتل الشامل:
powershell -File $env:TEMP\opencode\hold4173.ps1   # في عملية منفصلة
.\target\dev-fast\motard-fabrics-erp.exe           # انتظر ~120s للحوار المميت
# تحقق: صفر node + صفر postgres جديدة + التطبيق حي (الحوار) — ثم OK للخروج
```

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
