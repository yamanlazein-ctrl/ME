# بناء تطبيق Windows — Motard Fabrics Group ERP

## المتطلبات

1. **Windows 10/11** (أو cross-compile من Linux/Mac)
2. **Rust + Cargo** — `rustup` مع target `x86_64-pc-windows-msvc`
3. **Node.js 22+**
4. **Visual Studio Build Tools** (Windows C++ compiler)

## تثبيت الأدوات

```powershell
# Rust (على Windows)
Invoke-WebRequest -Uri https://win.rustup.rs -OutFile rustup-init.exe
.\rustup-init.exe -y

# Visual Studio Build Tools (C++ workload)
winget install Microsoft.VisualStudio.2022.BuildTools
# أو من: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
# حدد: Desktop development with C++

# Node.js
winget install OpenJS.NodeJS
```

## بناء المشروع

```powershell
# 1. انتقل لمجلد المشروع
cd desktop

# 2. تثبيت Node.js dependencies
npm install

# 3. تثبيت Rust dependencies
cd src-tauri
cargo fetch

# 4. بناء الملفات (تجميع frontend + Rust)
cd .. && npm run tauri:build
```

## مخرجات البناء

بعد النجاح، يوجد في `desktop/src-tauri/target/release/bundle/`:

| الملف       | الوصف                           |
| ----------- | ------------------------------- |
| `msi/*.msi` | Windows Installer (recommended) |

> ملاحظة: `tauri.conf.json` الحالي يحدد `"targets": ["msi"]` فقط. لتفعيل NSIS أو exe محمول، أضف `"nsis"` أو `"app"` إلى مصفوفة `bundle.targets` أولاً.

## خصائص التطبيق

- ✅ ربط الترخيص بـ 3 أجهزة
- ✅ تجربة 14 يوم بدون ترخيص
- ✅ فترة سماح 7 أيام بعد انتهاء الترخيص
- ✅ فحص ذاتي (fingerprint) CPU + MAC + hostname
- ✅ عربي + إنجليزي
- ✅ Auto-update (قابل للتفعيل)

## نشر التطبيق

### الطريقة 1: MSI Installer (موصى بها)

```powershell
# التطبيق يُثبّت في Program Files مع اختصار Start Menu
# يدعم إلغاء التثبيت من Control Panel
```

### الطريقة 2: Portable EXE

```powershell
# نسخ الملف .exe فقط + مجلد المشروع كاملاً
# يعمل من USB أو أي مجلد
```

### الطريقة 3: تثبيت صامت (Silent)

```powershell
# MSI صامت (للشركات)
msiexec /i MotardFabricsERP-1.0.0.msi /quiet /norestart
```

## سياسة بيانات إلغاء التثبيت (opt-in — البيانات محفوظة افتراضيًا)

عند إلغاء التثبيت الحقيقي (uninstall من Control Panel، وليس ترقية) يمكن للـMSI
حذف مجلد بيانات المستخدم بالكامل:

```
%LOCALAPPDATA%\motard-erp\   (قاعدة البيانات الحية pgdata + السجلات + secrets.dat)
```

**لكن هذا لا يحدث إلا بطلب صريح.** الحذف مقيّد بخاصية عامة (opt-in):

| الأمر | النتيجة |
|---|---|
| `msiexec /x motard-erp.msi` | **البيانات محفوظة** — السلوك الافتراضي |
| `msiexec /x motard-erp.msi MOTARD_WIPEDATA=1` | حذف `%LOCALAPPDATA%\motard-erp` بالكامل |

التنفيذ: `desktop/src-tauri/wix-cleanup.wxs` (CustomAction مؤجلة، `Return=ignore`،
تعمل بصفة المستخدم). الشرط الكامل:

```
REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND MOTARD_WIPEDATA="1"
```

أي لا تعمل عند الترقية/الإصلاح، ولا تعمل في إلغاء التثبيت العادي.

**لماذا البوابة:** بقايا قواعد الاختبار (`erp_e2e*`، `erp_wizard_test*`...) كانت
تُعاد استخدامها بصمت بعد إعادة التثبيت وتسبب لبساً — لذلك في مرحلة الاختبار يجب
تمرير `MOTARD_WIPEDATA=1` صراحةً. أما عميل الإنتاج فبياناته محفوظة افتراضيًا،
و"إعادة الضبط المصنعي" تبقى إجراءً منفصلاً متعمداً من داخل التطبيق (شاشة إعدادات
الخادم على سطح المكتب): تكتب `factory-reset.requested` ثم عند الإقلاع التالي تُحذف
`pgdata` و`db-meta.json` و`hub-session.json` مع الإبقاء على `device-binding.dat`
و`secrets.dat`. لا يغيّر المثبّت السلوك الافتراضي (حفظ البيانات).

## هوية التثبيت وترقية المخطط

`%LOCALAPPDATA%\motard-erp\db-meta.json` يخزن `installation_id` + إصدار PostgreSQL +
فهرس مخطط Drizzle. إعادة استخدام `pgdata` من تثبيت آخر تُرفض. الإقلاع يشغّل
`drizzle migrate()` قبل `listen`؛ قاعدة أحدث من البرنامج تُرفض (لا يوجد مسار تراجع).
بعد قتل قاسٍ، مسار إعادة الاستخدام يمسح `postmaster.pid` إن كانت العملية ميتة.

**فحص أن البوابة ما زالت قائمة** (بدون بناء MSI كامل): ترجَم الـfragment وحده
وتأكد من وجود الشرط في المخرَج — وهو ما يفعله candle في أي بناء عادي.

## تسريع الإقلاع: استثناء Windows Defender (خطوة اختيارية موصى بها)

يقيس الإقلاع الدافئ ~27 ثانية على جهاز مرجعي، معظمها تحميل وحدات Node.js
(الباك-إند ~21s) تحت الفحص الآني لـDefender — وأول إقلاع أطول (نسخ قالب
pgdata بحجم ~177MB). لا نفرض أي استثناء برمجياً من المثبّت (تعديل استثناءات
الحماية تلقائياً يتطلب صلاحيات مرتفعة وقد يُقرأ كسلوك مريب) — هذه خطوة يدوية
يقررها مسؤول كل جهاز:

1. افتح **Windows Security ← Virus & threat protection ← Manage settings ←
   Exclusions ← Add an exclusion ← Folder**.
2. أضف مجلد التثبيت: `C:\Program Files\Motard Fabrics Group ERP`
3. أضف مجلد البيانات: `%LOCALAPPDATA%\motard-erp`
4. أعد فتح التطبيق وقارن زمن ظهور الواجهة الجاهزة.

أثر متوقع: تقليص واضح في زمن الإقلاع البارد والدافئ معاً (الفحص الآني لعشرات
آلاف ملفات `node_modules` هو العامل الخارجي الأكبر).

## تعديلات مطلوبة قبل البناء

### 1. أيقونة التطبيق

استبدل `desktop/src-tauri/icons/icon.png` بأيقونة بمقاسات متعددة:

- `icon.png` (512x512)
- `icon.ico` (16, 32, 48, 128, 256 — Windows)
- `icon.icns` (Apple — اختياري)

### 2. تخصيص Installer

عدّل `desktop/src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "wix": {
        "language": ["ar-SA", "en-US"],
        "license": "../../LICENSE.txt"
      }
    }
  }
}
```

### 3. توقيع الكود (Code Signing) — اختياري لكن موصى

```powershell
# سجل الشهادة (من أي CA أو Let's Encrypt)
signtool sign /f certificate.pfx /p password /t http://timestamp.digicert.com MotardFabricsERP.exe
```

## استكشاف الأخطاء

### مشكلة: `tauri` لا يُنشئ نافذة

```powershell
# تأكد من أن backend يعمل على 127.0.0.1:8080 (backend/.env → PORT=8080)
# أو عدّل proxy في vite.config.ts
```

### مشكلة: رقم ترخيص غير صحيح

```powershell
# التطبيق يحتاج اتصال بالخادم للتفعيل
# استخدم license key من admin-dashboard: http://localhost:5173
```

## متبقٍ قبل التسليم النهائي

> قائمة بنود يجب إنجازها قبل تسليم الـEXE الفعلي للعميل. هذه الأيقونة الحالية
> هي **placeholder مؤقّتة** وليست تصميماً نهائياً.

- [ ] **استبدال أيقونة التطبيق بشعار احترافي حقيقي:** الأيقونة الحالية
  `desktop/src-tauri/icons/icon.ico` (وكذلك `icon.png`) هي أيقونة placeholder
  اصطناعية (خلفية ذهبية + حرف "M") ولّدت آلياً لغرض تمرير بناء `tauri-build`
  فقط. يجب استبدالها بشعار الشركة الرسمي (مربّع، ≥256×256، متعدد المقاسات)
  قبل التسليم للعميل. الخطوة 10 من خطة التحزيم كانت تشير إلى أن `icon.png`
  الأصلي كان تالفاً (1×1) — تم تجاوز العائق مؤقتاً بهذه الـplaceholder.

## التحديث التلقائي (Auto-Update)

مفعّل في الكود: `tauri-plugin-updater` + `bundle.createUpdaterArtifacts` + قسم `plugins.updater` في `tauri.conf.json`.

بيانات العميل تبقى في `%LOCALAPPDATA%\motard-erp` (خارج مجلد التثبيت). ترقية MSI/NSIS لا تشغّل `wix-cleanup.wxs` (ذلك المسار فقط عند `REMOVE=ALL AND NOT UPGRADINGPRODUCTCODE AND MOTARD_WIPEDATA=1`). إعادة ضبط المصنع من داخل التطبيق منفصلة.

قبل أول إصدار موقّع، ولّد المفتاح على جهاز البناء (لا يُحفظ المفتاح الخاص في git):

```
npx @tauri-apps/cli signer generate --ci -w desktop/src-tauri/updater.key
```

انسخ الـpubkey المطبوع إلى `plugins.updater.pubkey`. ابنِ الحزمة ثم:

```
node desktop/scripts/write-latest-json.mjs --version 1.0.1 --url <URL-NSIS> --signature <ملف .sig> --out latest.json
```

انشر `latest.json` على `https://updates.motardfabrics.com/desktop/latest.json`. المثبّت المفضّل للتحديث هو NSIS؛ MSI يبقى للتثبيت الكامل الأول.
