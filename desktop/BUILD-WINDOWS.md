# بناء تطبيق Windows — Motard Fabrics Group ERP

نسخة سطح المكتب = **غلاف Tauri رفيع** + **خادم Node واحد** (API + الواجهة معاً) + **PostgreSQL**. لا SSR، ولا منافذ ثابتة.
القرار المعماري وأسبابه: `docs/decisions.md` (ADR-DESKTOP-2026).

## الهيكل وقت التشغيل

```
Tauri shell (Rust)  ──starts──►  PostgreSQL 17 (127.0.0.1:<منفذ عشوائي عالي>)
        │                        Node 22: server.mjs  (127.0.0.1:<منفذ عشوائي ثابت محفوظ>)
        │                             ├─ /api/*   الـ API
        │                             └─ /*       الواجهة (SPA ثابتة) على نفس الأصل
        └─ نافذة WebView2 تُنشأ بعد أن يعلن الخادم منفذه (ملف server-port.json)
```

- منفذ الخادم عشوائي عالٍ (20000–40000) يُختار **مرة واحدة** ويُحفَظ (`server-port.pref`) ويُعاد استخدامه في كل تشغيل، فيبقى
  أصل المتصفح ثابتاً (الجلسة وإعدادات الجهاز تُخزَّن بحسب الأصل)؛ لا يتغيّر إلا إذا كان مشغولاً فعلاً. لا 8080 ولا 4173.
- الخادم يكتب منفذه الفعلي في `%LOCALAPPDATA%\motard-erp\server-port.json` **بعد** أن يصبح جاهزاً فعلاً.
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
#   DESKTOP_ADMIN_PASSWORD  كلمة مرور المدير الأولية (12 حرفاً فأكثر؛ يُخزَّن Argon2 hash فقط)
#   DESKTOP_LICENSE_KEY     اختياري: LIC-DESKTOP-… (الافتراضي عشوائي)
#   مفتاح توقيع الترخيص: LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY أو backend\.env
npx tauri build
```

`before-build.cmd` ينفّذ بالترتيب، وأي فشل يوقف البناء:

1. `stage-node-runtime.mjs` — node.exe المحمول (مثبّت الإصدار).
2. `build-frontend.cmd` — واجهة SPA (`VITE_DESKTOP_DEPLOY=true`) ← `resources/server/web`.
3. `bundle-server.mjs` — الباك-إند كملف واحد بـesbuild + عمّال pino + argon2 الأصلي + الهجرات ← `resources/server`
   (حوالي 100 ملف بدل 19 ألف).
4. `build-pgdata-template.mjs` — قاعدة نظيفة: `initdb` ← كل الهجرات ← شركة + مدير فقط ← الترخيص الموقّع
   ← `pg_ctl stop -m smart` ← `resources/postgres/pgdata-template`.
5. `verify-pgdata-template.mjs` — بوابة: مُهاجَر بالكامل، لا بيانات أعمال، `document_sequences` فارغ، إغلاق نظيف.
6. `server-bundle.test.mjs` — اختبار تشغيل حقيقي للخادم المُحزَّم على منفذ حر (مع احتلال 8080 و4173 عمداً).
7. `validate-resource-manifest.mjs` — كل ملف تشغيل مطلوب موجود وغير فارغ.

## المخرجات

`desktop/src-tauri/target/release/bundle/nsis/*-setup.exe` — مثبّت **لكل مستخدم** (`installMode: currentUser`):
لا يطلب صلاحيات مدير ولا UAC، ولا يستخدم MSI (MSI يسجّل كل ملف ويحفظ نسخة تراجع له، وهذا ما جعل التثبيت
القديم يتجاوز 10 دقائق). التثبيت الصامت: `Motard...-setup.exe /S`.

## بيانات المستخدم

`%LOCALAPPDATA%\motard-erp\` (قاعدة البيانات `pgdata`، `secrets.dat`، `server.log`، `logs\`). إلغاء التثبيت العادي
**لا** يحذفها. «إعادة الضبط المصنعي» إجراء متعمَّد من داخل التطبيق.

## تسريع أول تشغيل: استثناء Windows Defender (اختياري)

الفحص الآني لآلاف الملفات هو أكبر عامل بطء في أول تشغيل. الحزمة الآن أقل من 6 آلاف ملف بدل 33 ألفاً، لكن
يمكن للمسؤول إضافة مجلد التثبيت `%LOCALAPPDATA%\Programs\Motard Fabrics Group ERP` ومجلد البيانات
`%LOCALAPPDATA%\motard-erp` إلى الاستثناءات (Windows Security ← Exclusions). لا يفعل المثبّت ذلك تلقائياً.
