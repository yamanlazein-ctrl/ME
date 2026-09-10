# خطة إصلاح تغليف Windows Desktop — Motard Fabrics ERP

> **موجَّه لنموذج AI منفّذ.** هذا الملف نتيجة تشخيص كامل (قراءة فعلية لكل ملفات
> `desktop/src-tauri/src/*.rs`، فحص `git status`/`git diff`، قياس بايتات فعلي عبر
> PowerShell لكل مجلد في `resources/`). لا تُعِد التشخيص من الصفر — استخدم هذا الملف
> كمرجع دقيق لمكان كل تعديل وسببه. عند التنفيذ الفعلي: نفّذ **مرحلة واحدة فقط** في كل
> جلسة عمل، وشغّل `cargo build` (على الأقل `cargo check`) بعد كل بند لضمان أن الكود ما
> زال يُصرَّف قبل الانتقال للبند التالي.
>
> **حالة الملفات وقت كتابة هذه الخطة (مرجع فقط، تحقق من `git status` قبل البدء):**
> `desktop_runtime.rs`, `device_binding.rs`, `secret_store.rs`, `lib.rs`, وكامل
> `resources/` غير مُتتبَّعة في git (`??`). `main.rs`, `Cargo.toml`, `tauri.conf.json`
> معدَّلة وغير مُثبَّتة (`M`). لا يوجد أي commit سابق لهذه الملفات الجديدة لمقارنتها معه.
>
> **لا يوجد أي بند في هذه الخطة يمسّ منطق الأسعار/المحاسبة/الترخيص الفعلي** — كل التعديلات
> إما (أ) تحويل فشل صامت إلى حوار خطأ ظاهر بنفس منطق الفشل الأصلي، أو (ب) حذف ملفات تغليف
> غير مُستخدَمة وقت التشغيل، أو (ج) تنظيف إعدادات بناء/توثيق. لذلك لا يوجد قسم "⚠️ يحتاج
> موافقة صريحة" في هذا الملف.

---

## المرحلة 1 (أولوية قصوى مطلقة): وصل كل مسار فشل بحوار خطأ ظاهر

**لماذا هذه المرحلة أولاً:** التطبيق مبني بـ `#![cfg_attr(not(debug_assertions),
windows_subsystem = "windows")]` (`main.rs:1`) — في بناء الإصدار (release) **لا توجد نافذة
console على الإطلاق**. أي `eprintln!` لا يراه أحد. حالياً فقط مسارَين من أصل ٨ مسارات فشل
حقيقية يستدعيان `show_fatal_dialog` (رسالة MessageBoxW عربية). البقية تخرج بصمت تام
(`std::process::exit`) بلا أي رسالة. هذا هو أهم خلل مكتشف في التشخيص الكامل، ويجب إصلاحه
**قبل** أي تعديل آخر (بما فيها تقليص الحجم في المرحلة 3) لأن أي عطل جديد يظهر أثناء تلك
المرحلة يجب أن يكون قابلاً للتشخيص عبر رسالة واضحة، لا انهياراً صامتاً يصعب تتبعه.

**أداة مشتركة تُستخدم في كل بند من هذه المرحلة:** الدالة
`fn show_fatal_dialog(title: &str, message: &str)` المعرَّفة في
`desktop/src-tauri/src/desktop_runtime.rs:297-319` (نسخة `#[cfg(windows)]` حقيقية تستخدم
`MessageBoxW` مباشرة، ونسخة `#[cfg(not(windows))]` فارغة). هذه الدالة **غير `pub` حالياً**
— أول خطوة تقنية قبل أي بند أدناه:

### 0. جعل `show_fatal_dialog` قابلة للاستخدام من خارج `desktop_runtime.rs`
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:297` و `desktop/src-tauri/src/desktop_runtime.rs:318`
**المشكلة الحالية:**
```rust
#[cfg(windows)]
fn show_fatal_dialog(title: &str, message: &str) {
    ...
}

#[cfg(not(windows))]
fn show_fatal_dialog(_title: &str, _message: &str) {}
```
غير مرئية خارج الملف — لازمة للمرحلة 2 (main.rs) وممكن أن تُستدعى من نفس الملف داخلياً بلا
مشكلة، لكن main.rs لن يستطيع استدعاءها إطلاقاً بدون هذا التعديل.
**التعديل المطلوب:** أضف `pub` لكلا التعريفين:
```rust
#[cfg(windows)]
pub fn show_fatal_dialog(title: &str, message: &str) {
```
```rust
#[cfg(not(windows))]
pub fn show_fatal_dialog(_title: &str, _message: &str) {}
```
**كيف تتحقق من نجاح الإصلاح:** `cargo check` من `desktop/src-tauri` — يجب أن يُصرَّف بلا
أخطاء جديدة (هذا التعديل وحده لا يُستخدَم بعد؛ التحقق الحقيقي يأتي مع بند main.rs في
المرحلة 2).
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.1 مسار صامت: فشل ربط الجهاز (device binding)
**الملف:** `desktop/src-tauri/src/main.rs:15-18`
**المشكلة الحالية:**
```rust
    if let Err(e) = motard_fabrics_erp::device_binding::ensure_device_binding() {
        eprintln!("FATAL: device binding failed ({:?}) — refusing to start.", e);
        std::process::exit(2);
    }
```
`e` من نوع `device_binding::DeviceBindError` (`Tampered` أو `Io(String)`، معرَّف علناً في
`device_binding.rs:23-29`). لا رسالة للمستخدم إطلاقاً.
**التعديل المطلوب:**
```rust
    if let Err(e) = motard_fabrics_erp::device_binding::ensure_device_binding() {
        eprintln!("FATAL: device binding failed ({:?}) — refusing to start.", e);
        let msg = match &e {
            motard_fabrics_erp::device_binding::DeviceBindError::Tampered => {
                "تعذّر التحقق من ربط هذا الجهاز بالتثبيت.\n\n\
                 السبب الأكثر شيوعاً: تم نسخ مجلد البرنامج إلى جهاز أو حساب مستخدم مختلف \
                 عن الجهاز الذي جرى التثبيت عليه أصلاً.\n\n\
                 الحل: أعد تثبيت البرنامج على هذا الجهاز بحساب المستخدم الحالي، أو تواصل \
                 مع الدعم الفني."
                    .to_string()
            }
            motard_fabrics_erp::device_binding::DeviceBindError::Io(detail) => format!(
                "تعذّر إنشاء أو قراءة ملف ربط الجهاز (device-binding.dat).\n\n\
                 الخطأ: {}\n\n\
                 تأكد من:\n\
                 1) صلاحيات الكتابة في مجلد AppData\\Local\\motard-erp\n\
                 2) أن برنامج الحماية (Antivirus) لا يمنع الكتابة",
                detail
            ),
        };
        motard_fabrics_erp::desktop_runtime::show_fatal_dialog(
            "خطأ في ربط الجهاز — Motard ERP",
            &msg,
        );
        std::process::exit(2);
    }
```
**ملاحظة تنفيذية:** هذا البند يعتمد على البند 0 أعلاه (`show_fatal_dialog` يجب أن تكون
`pub`) وعلى أن `DeviceBindError` تدعم `Debug` (موجودة بالفعل: `#[derive(Debug)]` في
`device_binding.rs:23`).
**كيف تتحقق من نجاح الإصلاح:** ابنِ نسخة release (`cargo build --release` أو عبر
`npm run tauri:build`)، شغّل الـ exe الناتج. لمحاكاة `Tampered`: احذف
`%LOCALAPPDATA%\motard-erp\device-binding.dat` بعد تشغيل ناجح واحد، ثم انسخه يدوياً من نسخة
مثبَّتة على مستخدم Windows آخر (أو عدّل بايتاً واحداً داخل الملف بمحرر hex) وشغّل التطبيق —
يجب أن يظهر MessageBox عربي بعنوان "خطأ في ربط الجهاز" بدل اختفاء العملية بصمت. لمحاكاة
`Io`: اجعل مجلد `%LOCALAPPDATA%\motard-erp` للقراءة فقط (خصائص → للقراءة فقط، أو
`icacls` لمنع الكتابة) قبل أول تشغيل، وتأكد من ظهور رسالة الخطأ الثانية بدل اختفاء صامت.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.2 مسار صامت: فشل `ensure_pgdata` (تجهيز مجلد قاعدة البيانات)
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:462` (داخل `boot_desktop_stack`،
تعريف الدالة نفسها في `desktop_runtime.rs:134-191`)
**المشكلة الحالية:**
```rust
    let pgdata = ensure_pgdata(&cfg.resources_root, &cfg.app_data_root)?;
```
عند فشل `initdb` (السطر 184-189) أو فشل النسخ من `pgdata-template` (`copy_dir_all`، قد يفشل
لمساحة قرص ممتلئة)، يُرجَع `io::Error` يصعد عبر `?` إلى `main.rs` حيث يُطبَع فقط بـ
`eprintln!` (`main.rs:38`) بلا حوار.
**التعديل المطلوب:**
```rust
    let pgdata = match ensure_pgdata(&cfg.resources_root, &cfg.app_data_root) {
        Ok(p) => p,
        Err(e) => {
            let msg = format!(
                "تعذّر تجهيز مجلد قاعدة البيانات المحلية (pgdata).\n\n\
                 الخطأ: {}\n\n\
                 الأسباب المحتملة:\n\
                 1) مساحة القرص ممتلئة\n\
                 2) برنامج الحماية يمنع الكتابة في مجلد AppData\\Local\\motard-erp\\pgdata\n\
                 3) قالب قاعدة البيانات المرفق (postgres\\pgdata-template) تالف أو ناقص\n\n\
                 الحل: تحقق من المساحة المتاحة وصلاحيات الكتابة، ثم أعد تشغيل مثبّت \
                 البرنامج (Repair) إن استمرت المشكلة.",
                e
            );
            show_fatal_dialog("خطأ في تجهيز قاعدة البيانات — Motard ERP", &msg);
            return Err(e);
        }
    };
```
(هذا الاستدعاء لـ `show_fatal_dialog` داخلي — لا حاجة لـ `crate::desktop_runtime::` لأنه
بالفعل داخل نفس الملف، بعكس بند main.rs.)
**كيف تتحقق من نجاح الإصلاح:** احذف/أعد تسمية `desktop/src-tauri/resources/postgres/pgdata-template`
مؤقتاً (أو احذف `PG_VERSION` منه فقط) بحيث يفشل شرط `template.join("PG_VERSION").exists()`
في السطر 146 ويذهب المسار لتنفيذ `initdb` — ثم أعد تسمية `initdb.exe` مؤقتاً في
`resources/postgres/bin` بحيث يفشل `Command::new(&initdb)` بخطأ "الملف غير موجود". شغّل
التطبيق (نسخة release) وتأكد من ظهور الحوار العربي بدل اختفاء العملية. **أعد كل الأسماء
لوضعها الأصلي بعد الاختبار.**
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.3 مسار صامت: فشل `sync_pg_conf_port`
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:465` (تعريف الدالة:
`desktop_runtime.rs:230-256`)
**المشكلة الحالية:**
```rust
    sync_pg_conf_port(&pgdata, cfg.db_port)?;
```
يفشل إذا تعذّرت قراءة/كتابة `postgresql.conf` داخل `pgdata` (مثلاً: تلف الملف الناتج عن نسخ
`pgdata-template` غير مكتمل).
**التعديل المطلوب:**
```rust
    if let Err(e) = sync_pg_conf_port(&pgdata, cfg.db_port) {
        let msg = format!(
            "تعذّر تحديث إعدادات منفذ قاعدة البيانات (postgresql.conf).\n\n\
             الخطأ: {}\n\n\
             قد يكون ملف الإعداد داخل مجلد بيانات القاعدة تالفاً. جرّب حذف مجلد \
             AppData\\Local\\motard-erp\\pgdata بالكامل (بعد أخذ نسخة احتياطية إن وُجدت \
             بيانات) ثم أعد تشغيل البرنامج ليعيد تجهيزه من جديد.",
            e
        );
        show_fatal_dialog("خطأ في إعدادات قاعدة البيانات — Motard ERP", &msg);
        return Err(e);
    }
```
**كيف تتحقق من نجاح الإصلاح:** بعد تشغيل ناجح واحد (بحيث تتشكّل `pgdata`)، أغلق التطبيق ثم
افتح `%LOCALAPPDATA%\motard-erp\pgdata\postgresql.conf` واحذف صلاحية الكتابة عنه فقط
(`icacls postgresql.conf /deny %USERNAME%:W`)، ثم شغّل التطبيق مجدداً وتأكد من ظهور الحوار
بدل اختفاء صامت. **أعد الصلاحية بعد الاختبار** (`icacls postgresql.conf /remove:d %USERNAME%`).
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.4 مسار صامت: فشل `start_postgres` (الأكثر احتمالاً في الواقع)
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:466` (تعريف الدالة:
`desktop_runtime.rs:322-375`)
**المشكلة الحالية:**
```rust
    start_postgres(&cfg.resources_root, &pgdata, cfg.db_port)?;
```
هذا هو المسار الأكثر ترجيحاً للفشل في الواقع الفعلي (تعارض منفذ 5432 مع خدمة PostgreSQL
أخرى مثبَّتة على جهاز العميل، أو برنامج حماية يحجب `postgres.exe` بعد أن اجتاز فحص
`preflight_check` — الذي يتحقق فقط من **وجود** الملف بـ `.exists()`، وليس من قدرته على
التشغيل الفعلي). الفشل حالياً يُرجَع كـ `io::Error` بلا حوار.
**التعديل المطلوب:**
```rust
    if let Err(e) = start_postgres(&cfg.resources_root, &pgdata, cfg.db_port) {
        let msg = format!(
            "تعذّر تشغيل قاعدة البيانات المحلية (PostgreSQL).\n\n\
             الخطأ: {}\n\n\
             الأسباب المحتملة:\n\
             1) برنامج آخر يستخدم المنفذ {} حالياً (مثل نسخة PostgreSQL أخرى مثبَّتة على \
                الجهاز)\n\
             2) برنامج الحماية (Antivirus) يمنع تشغيل postgres.exe\n\
             3) مجلد بيانات القاعدة تالف\n\n\
             راجع ملف السجل لمزيد من التفاصيل: {}\\pg.log\n\n\
             الحل: أغلق أي برنامج PostgreSQL آخر يعمل على الجهاز، أضف مجلد التثبيت \
             لاستثناءات الحماية، ثم أعد فتح البرنامج.",
            e,
            cfg.db_port,
            pgdata.display()
        );
        show_fatal_dialog("خطأ في تشغيل قاعدة البيانات — Motard ERP", &msg);
        return Err(e);
    }
```
**كيف تتحقق من نجاح الإصلاح:** شغّل أي خدمة تستمع على المنفذ 5432 مسبقاً (مثلاً:
`docker run -p 5432:5432 postgres` أو أي PostgreSQL محلي آخر مثبَّت)، ثم شغّل التطبيق —
يجب أن يفشل `pg_ctl start` بسبب تعارض المنفذ ويظهر الحوار أعلاه (بدل اختفاء صامت). أوقف
الخدمة المتعارضة بعد الاختبار.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

> **ملاحظة إضافية غير منفصلة (تُنفَّذ مع هذا البند نفسه لأنها في نفس الدالة):**
> `desktop_runtime.rs:358-370` — نتيجة `createdb` يتم تجاهلها بالكامل عبر
> `let _ = Command::new(&createdb)....status();`. التعليق الحالي يقول "idempotent — errors
> ignored"، لكن هذا يُخفي أيضاً فشلاً حقيقياً (مثل خطأ صلاحيات أو منفذ خاطئ) وليس فقط حالة
> "القاعدة موجودة مسبقاً". **لا تُغيّر هذا السطر في هذه المرحلة** (تغييره يتطلب تمييز
> "القاعدة موجودة" عن فشل حقيقي عبر فحص نص الخطأ، وهذا تعديل منطقي أدق يُفضَّل تأجيله لمرحلة
> منفصلة بعد استقرار المرحلة 1). فقط وثّقه هنا كملاحظة معروفة، غير مطلوب إصلاحها الآن.

---

### 1.5 مسار صامت: فشل `spawn_backend`
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:492` (تعريف الدالة:
`desktop_runtime.rs:378-413`)
**المشكلة الحالية:**
```rust
    let backend = spawn_backend(cfg, &store)?;
```
يفشل إذا تعذّر تشغيل `node.exe` (مفقود، محجوب من الحماية، أو تالف).
**التعديل المطلوب:**
```rust
    let backend = match spawn_backend(cfg, &store) {
        Ok(b) => b,
        Err(e) => {
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر تشغيل محرّك النظام (Node.js backend).\n\n\
                 الخطأ: {}\n\n\
                 المسار المتوقَّع: {}\n\n\
                 السبب الأكثر شيوعاً: برنامج الحماية حذف أو حجر node.exe بعد التثبيت.\n\n\
                 الحل: أضف مجلد تثبيت البرنامج لاستثناءات الحماية، ثم أعد تشغيل مثبّت \
                 البرنامج (Repair).",
                e,
                cfg.node_exe.display()
            );
            show_fatal_dialog("خطأ في تشغيل محرّك النظام — Motard ERP", &msg);
            return Err(e);
        }
    };
```
لاحظ إضافة `let _ = stop_postgres(...)` — بدون هذا، فشل بدء الـ backend يترك عملية
`postgres.exe` تعمل بلا داعٍ في الخلفية (نفس نمط التنظيف المطبَّق فعلاً في مسار فشل
secrets عند السطر 473 وفشل health-check عند السطر 501).
**كيف تتحقق من نجاح الإصلاح:** أعد تسمية `desktop/src-tauri/resources/node.exe` مؤقتاً إلى
اسم آخر، ابنِ وشغّل نسخة release — يجب أن يظهر الحوار أعلاه، وأن تتأكد (عبر Task Manager)
أن `postgres.exe` **لا يبقى** يعمل بعد ظهور الرسالة وإغلاق التطبيق. أعد اسم `node.exe`
الأصلي بعد الاختبار.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.6 مسار صامت: انتهاء مهلة فحص جاهزية الـ backend (`/api/health/live`)
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:495-506`
**المشكلة الحالية:**
```rust
    let live = wait_for(
        || http_get_ok("127.0.0.1", cfg.backend_port, "/api/health/live"),
        Duration::from_secs(60),
    );
    if !live {
        // Best-effort cleanup so a failed boot does not leave postgres running.
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "backend did not become healthy (/api/health/live)",
        ));
    }
```
التنظيف موجود بالفعل، لكن لا يوجد حوار — هذا بالضبط الحالة التي صُمِّم `show_fatal_dialog`
من أجلها (خادم لا يستجيب بعد مهلة معقولة) ومع ذلك لم تُوصَل به.
**التعديل المطلوب:**
```rust
    if !live {
        // Best-effort cleanup so a failed boot does not leave postgres running.
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let msg = format!(
            "بدأ محرّك النظام لكنه لم يستجب خلال المهلة المتوقَّعة (60 ثانية).\n\n\
             المنفذ: {}\n\n\
             قد يكون الجهاز بطيئاً جداً في الإقلاع الأول، أو برنامج الحماية يفحص الملفات \
             ببطء. أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.",
            cfg.backend_port
        );
        show_fatal_dialog("خطأ: محرّك النظام لم يستجب — Motard ERP", &msg);
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "backend did not become healthy (/api/health/live)",
        ));
    }
```
**كيف تتحقق من نجاح الإصلاح:** أصعب حالة للمحاكاة الحقيقية لأنها تعتمد على توقيت الشبكة —
أسهل طريقة: عدّل مؤقتاً `Duration::from_secs(60)` في هذا الموضع فقط إلى
`Duration::from_millis(50)` (قيمة صغيرة جداً بحيث يفشل الفحص دائماً)، ابنِ وشغّل، تأكد من
ظهور الحوار، ثم **أعد القيمة إلى `60` قبل أي commit أو بناء نهائي**.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.7 مسار صامت: فشل `spawn_ssr`
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:511` (تعريف الدالة:
`desktop_runtime.rs:421-439`)
**المشكلة الحالية:**
```rust
    let mut ssr = spawn_ssr(cfg)?;
```
نفس فئة الخطأ في البند 1.5 (فشل تشغيل `node.exe`)، لكن هذه المرة الـ backend يكون قد بدأ
بالفعل — يجب إيقافه أيضاً عند الفشل هنا (غير موجود حالياً).
**التعديل المطلوب:**
```rust
    let mut ssr = match spawn_ssr(cfg) {
        Ok(s) => s,
        Err(e) => {
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            let msg = format!(
                "تعذّر تشغيل واجهة العرض (SSR frontend server).\n\n\
                 الخطأ: {}\n\n\
                 الحل: أضف مجلد تثبيت البرنامج لاستثناءات برنامج الحماية، ثم أعد تشغيل \
                 مثبّت البرنامج (Repair) إن استمرت المشكلة.",
                e
            );
            show_fatal_dialog("خطأ في تشغيل واجهة العرض — Motard ERP", &msg);
            return Err(e);
        }
    };
```
**ملاحظة:** الـ backend الذي بدأ في البند 1.5 (المتغيّر `backend`) يبقى يعمل هنا عند هذا
الفشل تحديداً لأن `boot_desktop_stack` لا يُرجِع `DesktopStack` كاملاً بعد؛ الأفضل هو أيضاً
قتل عملية `backend` هنا. أضِف `drop`/`kill` صريح:
```rust
    let mut ssr = match spawn_ssr(cfg) {
        Ok(s) => s,
        Err(e) => {
            let mut backend = backend; // نقل الملكية للتحكم بالإيقاف
            let _ = backend.kill();
            let _ = stop_postgres(&cfg.resources_root, &pgdata);
            /* ... نفس رسالة الحوار أعلاه ... */
            return Err(e);
        }
    };
```
(نفّذ النسخة الثانية — فيها إيقاف كامل لـ backend + postgres، وليس postgres فقط.)
**كيف تتحقق من نجاح الإصلاح:** بعد نجاح إقلاع الـ backend، احذف/أعد تسمية
`desktop/src-tauri/resources/ssr/serve.mjs` مؤقتاً — يجب أن يظهر الحوار، وأن تتأكد (Task
Manager) من عدم بقاء أي عملية `node.exe` أو `postgres.exe` عالقة بعد إغلاق الرسالة. أعد
اسم `serve.mjs` بعد الاختبار.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 1.8 مسار صامت: انتهاء مهلة جاهزية SSR
**الملف:** `desktop/src-tauri/src/desktop_runtime.rs:513-525`
**المشكلة الحالية:**
```rust
    let ssr_live = wait_for(
        || http_get_ok("127.0.0.1", SSR_PORT, "/"),
        Duration::from_secs(30),
    );
    if !ssr_live {
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let _ = ssr.kill();
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "SSR frontend did not become healthy (http://127.0.0.1:4173/)",
        ));
    }
```
نفس نمط 1.6: تنظيف موجود، حوار غير موجود.
**التعديل المطلوب:**
```rust
    if !ssr_live {
        let _ = stop_postgres(&cfg.resources_root, &pgdata);
        let _ = ssr.kill();
        let msg = "بدأت واجهة العرض لكنها لم تستجب خلال المهلة المتوقَّعة (30 ثانية).\n\n\
                    أعد فتح البرنامج مرة أخرى، وإن تكررت المشكلة تواصل مع الدعم الفني.";
        show_fatal_dialog("خطأ: واجهة العرض لم تستجب — Motard ERP", msg);
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "SSR frontend did not become healthy (http://127.0.0.1:4173/)",
        ));
    }
```
**كيف تتحقق من نجاح الإصلاح:** نفس أسلوب 1.6 — عدّل مؤقتاً `Duration::from_secs(30)` في هذا
الموضع فقط إلى `Duration::from_millis(50)`، تحقق من ظهور الحوار، **ثم أعد القيمة إلى `30`**.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

## المرحلة 2: توحيد panic المكرر ثلاث مرات + إصلاح main.rs المبكر

**لماذا بعد المرحلة 1 مباشرة:** هذه المرحلة تكمل نفس الهدف (لا انهيار صامت) لكنها تغطي
اللحظات الأبكر من أي شيء في المرحلة 1 — قبل حتى إنشاء `tauri::Builder`. يجب أن تأتي بعد
المرحلة 1 لأنها تعتمد على `show_fatal_dialog` وهي أصبحت `pub` فيها (البند 0)، وتُستخدَم هنا
مباشرة من `main.rs`.

### 2.1 دالة `app_data_dir` مشتركة بدل ثلاث نسخ مكرّرة بـ `.expect()`
**الملفات (ثلاث نسخ متطابقة المنطق حالياً):**
- `desktop/src-tauri/src/device_binding.rs:31-36` (باسم `binding_path`, يدمج بناء المسار الكامل)
- `desktop/src-tauri/src/secret_store.rs:25-31` (باسم `app_data_dir`)
- `desktop/src-tauri/src/desktop_runtime.rs:94-98` (باسم `app_data_dir`)

**المشكلة الحالية (نفس النمط في الثلاثة):**
```rust
// secret_store.rs:25-31
fn app_data_dir() -> PathBuf {
    let mut dir = dirs_sys::known_folder_local_app_data().expect("no app data dir");
    dir.push("motard-erp");
    dir
}
```
```rust
// device_binding.rs:31-36
fn binding_path() -> PathBuf {
    let mut dir = dirs_sys::known_folder_local_app_data().expect("no app data dir");
    dir.push("motard-erp");
    dir.push("device-binding.dat");
    dir
}
```
```rust
// desktop_runtime.rs:94-98
fn app_data_dir() -> PathBuf {
    let mut dir = dirs_sys::known_folder_local_app_data().expect("no app data dir");
    dir.push("motard-erp");
    dir
}
```
ثلاث نسخ مستقلة من نفس المنطق، وكلها تُنهي البرنامج بـ panic بلا رسالة إن فشلت (احتمال ضعيف
جداً في الواقع، لكنه يناقض بالضبط الهدف المعلن لإصلاح `secret_store.rs` السابق — الذي حوّل
كل شيء آخر في هذا الملف نفسه إلى `Result`).

**التعديل المطلوب:**

**الخطوة أ — تحقق أولاً من التوقيع الفعلي لـ `dirs_sys::known_folder_local_app_data()`**
(الإصدار المستخدم: `dirs-sys = "0.5"` في `Cargo.toml:28`). الاستخدام الحالي بـ `.expect(...)`
يدل على أنها تُرجِع `Option<PathBuf>` وليس `Result` (لأن `.expect()` يعمل على كلاهما) —
تأكد بفتح توثيق الحزمة (`cargo doc` محلياً أو docs.rs) قبل كتابة `.ok_or_else(...)` أدناه؛
إن كانت `Result<PathBuf, E>` استبدل `.ok_or_else(...)` بـ
`.map_err(|e| format!("...: {}", e))`.

**الخطوة ب — أضف دالة مشتركة واحدة في `desktop/src-tauri/src/lib.rs`:**
```rust
// ── Shared per-user app-data root ────────────────────────────────────────────
// Used by secret_store, device_binding, and desktop_runtime so the three
// modules can never disagree on where this lives. Returns Err instead of
// panicking so callers can show a dialog instead of crashing silently.
pub fn app_data_dir() -> Result<std::path::PathBuf, String> {
    let mut dir = dirs_sys::known_folder_local_app_data().ok_or_else(|| {
        "تعذّر تحديد مجلد AppData\\Local لهذا المستخدم (known_folder_local_app_data فشلت)"
            .to_string()
    })?;
    dir.push("motard-erp");
    Ok(dir)
}
```
(هذا يتطلب أن يكون `dirs_sys` متاحاً من `lib.rs` — هو بالفعل تبعية على مستوى الـ crate في
`Cargo.toml`، لا تعديل إضافي مطلوب هناك.)

**الخطوة ج — حدّث `secret_store.rs`:**
احذف `fn app_data_dir()` بالكامل (السطور 25-31). غيّر `secrets_path()`:
```rust
// كان:
pub fn secrets_path() -> PathBuf {
    let mut p = app_data_dir();
    p.push("secrets.dat");
    p
}
// يصبح:
pub fn secrets_path() -> Result<PathBuf, String> {
    let mut p = crate::app_data_dir()?;
    p.push("secrets.dat");
    Ok(p)
}
```
**كل مستدعي `secrets_path()` يجب تحديثهم أيضاً (تغيير التوقيع ينكسر بصمت إن نُسي أحدهم):**
- `secret_store.rs:105` داخل `load_or_generate()` — `let path = secrets_path();` يصبح
  `let path = secrets_path()?;` (الدالة أصلاً `-> Result<SecretStore, String>`، `?` يعمل
  مباشرة).
- `secret_store.rs:132,135` داخل `persist()` — استبدل `let dir = app_data_dir();` بـ
  `let dir = crate::app_data_dir()?;`، و `let sp = secrets_path();` بـ
  `let sp = secrets_path()?;` (الدالة أصلاً `-> Result<(), String>`، `?` يعمل مباشرة).
- `secret_store.rs:143` داخل `clear_for_test()` —
  `let _ = fs::remove_file(secrets_path());` يصبح
  `if let Ok(p) = secrets_path() { let _ = fs::remove_file(p); }` (هذه دالة اختبار فقط، لا
  داعٍ لإرجاع Result منها، فقط تجاهل بأمان إن فشل تحديد المسار).
- `desktop_runtime.rs:482` (داخل رسالة حوار فشل الأسرار الموجودة مسبقاً) —
  `secret_store::secrets_path().display()` يصبح:
  ```rust
  secret_store::secrets_path()
      .map(|p| p.display().to_string())
      .unwrap_or_else(|_| "<غير معروف>".to_string())
  ```
- `bin/d3_probe.rs:43` (أداة تطوير غير مُغلَّفة في MSI — راجع البند "1" في جدول التشخيص
  الأصلي، مصنَّفة Safe) — `let p = motard_fabrics_erp::secret_store::secrets_path();`
  يصبح `let p = motard_fabrics_erp::secret_store::secrets_path().expect("secrets_path");`
  — `.expect()` مقبول هنا لأنها أداة تشخيص يدوية غير مشحونة للعميل.

**الخطوة د — حدّث `device_binding.rs`:**
```rust
// كان (device_binding.rs:31-36):
fn binding_path() -> PathBuf {
    let mut dir = dirs_sys::known_folder_local_app_data().expect("no app data dir");
    dir.push("motard-erp");
    dir.push("device-binding.dat");
    dir
}
// يصبح:
fn binding_path() -> Result<PathBuf, DeviceBindError> {
    let mut dir = crate::app_data_dir().map_err(DeviceBindError::Io)?;
    dir.push("device-binding.dat");
    Ok(dir)
}
```
مستدعيها الوحيد `device_binding.rs:42`:
```rust
// كان:
    let path = binding_path();
// يصبح:
    let path = binding_path()?;
```
(`ensure_device_binding()` أصلاً `-> Result<(), DeviceBindError>`، `?` يعمل مباشرة).

**الخطوة هـ — حدّث `desktop_runtime.rs`:**
احذف `fn app_data_dir()` بالكامل (السطور 94-98). مستدعيها الوحيد هو
`BootConfig::for_app` في السطر 74 — هذا يتطلب تغيير توقيع `for_app` نفسها من `-> Self`
إلى `-> Result<Self, String>` (راجع البند 2.3 أدناه — نفس البند الذي يعدّل `main.rs:34`
لاستقبال هذا الـ Result، فالتعديلان متلازمان بالضرورة، نفّذهما معاً).

**كيف تتحقق من نجاح الإصلاح:** `cargo build` كامل (ليس `check` فقط) من `desktop/src-tauri`
بعد تطبيق كل الخطوات أ-هـ معاً — يجب أن يُصرَّف بلا أي خطأ أو تحذير جديد متعلق بأنواع غير
متطابقة. ثم تشغيل فعلي كامل (إقلاع → تسجيل دخول → إغلاق) للتأكد أن `secrets.dat` و
`device-binding.dat` و `pgdata` ما زالت تُنشأ في نفس المسار السابق تماماً
(`%LOCALAPPDATA%\motard-erp\`) — أي فرق في المسار يعني خطأ في الدمج.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 2.2 معالجة `main.rs:26` — فشل بناء تطبيق Tauri
**الملف:** `desktop/src-tauri/src/main.rs:20-26`
**المشكلة الحالية:**
```rust
    let mut app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_fingerprint,
            validate_license,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
```
هذا يعمل **قبل** أي آلية حوار أخرى في التطبيق تعتمد على Tauri نفسه — لكن `show_fatal_dialog`
لا تعتمد على Tauri إطلاقاً (تستدعي `windows::Win32::UI::WindowsAndMessaging::MessageBoxW`
مباشرة)، لذلك يمكن استدعاؤها هنا بأمان تام حتى قبل نجاح بناء تطبيق Tauri — وهذا بالضبط ما
اقترحه التشخيص: "آلية حوار Win32 خام مستقلة عن Tauri نفسه".
**التعديل المطلوب:**
```rust
    let mut app = match tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_fingerprint,
            validate_license,
        ])
        .build(tauri::generate_context!())
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("FATAL: tauri builder failed: {}", e);
            motard_fabrics_erp::desktop_runtime::show_fatal_dialog(
                "خطأ في تشغيل التطبيق — Motard ERP",
                &format!(
                    "تعذّر تهيئة إطار التطبيق.\n\n\
                     الخطأ: {}\n\n\
                     السبب الأكثر شيوعاً: مكوّن WebView2 Runtime غير مثبَّت أو تالف على هذا \
                     الجهاز.\n\n\
                     الحل: نزّل وثبّت \"WebView2 Runtime\" من موقع مايكروسوفت الرسمي ثم أعد \
                     فتح البرنامج.",
                    e
                ),
            );
            std::process::exit(4);
        }
    };
```
**ملاحظة:** يعتمد على البند 0 من المرحلة 1 (`show_fatal_dialog` يجب أن تكون `pub`).
**كيف تتحقق من نجاح الإصلاح:** إعادة إنتاج هذا الفشل تحديداً صعبة بدون إزالة WebView2 من
جهاز اختبار فعلياً (خطوة تدميرية على جهاز التطوير، **لا تُنفَّذها على جهازك الأساسي** — استخدم
جهازاً افتراضياً (VM) نظيفاً بلا WebView2 مثبَّت مسبقاً إن توفر، أو صندوق اختبار Windows
منفصل). البديل الأسلم للتحقق: راجع فقط أن الكود يُصرَّف (`cargo build`) وأن التطبيق يعمل
بشكل طبيعي تماماً على جهاز فيه WebView2 (السيناريو الشائع) — أي أن التعديل لم يكسر المسار
الناجح. التحقق الكامل من ظهور الحوار الفعلي يبقى بند اختياري إضافي إن توفرت بيئة اختبار
معزولة بدون WebView2.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 2.3 معالجة `main.rs:33` (`resource_dir`) و `main.rs:34` (`BootConfig::for_app`)
**الملف:** `desktop/src-tauri/src/main.rs:30-34`
**المشكلة الحالية:**
```rust
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("resource dir unavailable");
    let cfg = BootConfig::for_app(resource_dir);
```
`resource_dir()` نادراً ما تفشل (تثبيت تالف/غير مكتمل)، لكنها الآن أيضاً تتصل بـ
`BootConfig::for_app` التي — بعد تطبيق البند 2.1 — أصبحت `-> Result<Self, String>` بدل
`-> Self`، لذا هذا البند **مرتبط إلزامياً** بالبند 2.1 (لا يمكن تنفيذه قبله لأن `for_app`
لن تكون Result بعد).
**التعديل المطلوب:**
```rust
    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("FATAL: resource dir unavailable: {}", e);
            motard_fabrics_erp::desktop_runtime::show_fatal_dialog(
                "خطأ في ملفات التثبيت — Motard ERP",
                &format!(
                    "تعذّر تحديد مجلد موارد التطبيق.\n\n\
                     الخطأ: {}\n\n\
                     قد يكون التثبيت غير مكتمل أو تالف. أعد تشغيل مثبّت البرنامج (Repair) \
                     لإصلاح الملفات.",
                    e
                ),
            );
            std::process::exit(5);
        }
    };
    let cfg = match BootConfig::for_app(resource_dir) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("FATAL: BootConfig::for_app failed: {}", e);
            motard_fabrics_erp::desktop_runtime::show_fatal_dialog(
                "خطأ في إعداد بيانات التطبيق — Motard ERP",
                &format!(
                    "تعذّر تحديد مجلد بيانات المستخدم (AppData\\Local\\motard-erp).\n\n\
                     الخطأ: {}",
                    e
                ),
            );
            std::process::exit(6);
        }
    };
```
وفي `desktop_runtime.rs`، عدّل `BootConfig::for_app` نفسها (السطور 61-82) لتصبح:
```rust
    pub fn for_app(resource_dir: PathBuf) -> Result<Self, String> {
        let backend_dir = resource_dir.join("backend");
        let server_js = backend_dir
            .join("dist")
            .join("backend")
            .join("src")
            .join("presentation")
            .join("server.js");
        let license_public_key =
            fs::read_to_string(resource_dir.join("license-public.pem")).ok();
        Ok(BootConfig {
            resources_root: resource_dir.clone(),
            app_data_root: crate::app_data_dir()?,
            node_exe: resource_dir.join("node.exe"),
            backend_dir,
            server_js,
            license_public_key,
            db_port: 5432,
            backend_port: 8080,
        })
    }
```
**كيف تتحقق من نجاح الإصلاح:** رمز الخروج (`exit code`) أصبح مميّزاً لكل حالة (2 = ربط
الجهاز، 4 = بناء Tauri، 5 = resource_dir، 6 = BootConfig، 3 = boot_desktop_stack عام —
موجود مسبقاً). تحقق من هذا عبر `echo %ERRORLEVEL%` في cmd بعد كل محاكاة فشل من البنود
السابقة، وتأكد أن الرقم يطابق نقطة الفشل الفعلية — هذا يفيد لاحقاً في الدعم الفني عن بعد
(معرفة أين فشل التطبيق من رقم الخروج وحده بدون الحاجة لرؤية الشاشة). أعد بناء نسخة release
كاملة وشغّل دورة كاملة ناجحة (إقلاع → تسجيل دخول → إغلاق) للتأكد أن المسار السعيد لم ينكسر.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

## المرحلة 3: تقليص حجم الحزمة (~500+ ميجا، صفر مخاطرة وظيفية)

**لماذا بعد المرحلة 1 والمرحلة 2:** أي مشكلة تظهر أثناء هذه المرحلة (حذف ملف يتضح لاحقاً
أنه مطلوب، تعارض إصدار مكتبة بعد `npm install --omit=dev`، إلخ) يجب أن تُشخَّص عبر حوار
خطأ واضح من المرحلتين 1-2، لا انهياراً صامتاً يصعب ربطه بالسبب. **نفّذ كل بند من هذه
المرحلة على حدة، وابنِ MSI جديداً وشغّل دورة كاملة (إقلاع → تسجيل دخول → فتح فاتورة →
طباعة → إغلاق) بعد **كل بند منفرد** قبل الانتقال للبند التالي** — لا تجمع عدة بنود حذف في
بناء واحد، لأن ذلك يصعّب تحديد أي حذف تحديداً سبب أي كسر إن حدث.

### 3.1 إعادة بناء `node_modules` المُغلَّفة بدون تبعيات التطوير
**الملفات:**
- `desktop/src-tauri/resources/node_modules/` (350.0 MB — تُستخدَم من `ssr/serve.mjs:10-13`
  عبر resolution تلقائي لـ ESM bare imports صعوداً حتى أول `node_modules`)
- `desktop/src-tauri/resources/backend/node_modules/` (141.7 MB — تُستخدَم من
  `dist/backend/src/presentation/server.js`)

**المشكلة الحالية:** كلا المجلدين نسخة كاملة غير مُقلَّمة من `npm install` — تحتوي فعلياً
على `@playwright`, `playwright`, `playwright-core`, `@eslint`, `eslint`, `prettier`,
`typescript`, `typescript-eslint`, `@babel`, `axe-core`, `vite`, `vitest`, `@vitest` (في
النسخة العلوية)، و `typescript`, `drizzle-kit`, `tsx`, `@types` (في نسخة backend) — لا شيء
من هذا يُستخدَم وقت التشغيل الفعلي؛ كلها devDependencies. هذا وحده مصدر أكبر جزء من فجوة
حجم MSI (272 MB مضغوط) مقابل الحجم المثبَّت (1.15 GB)، ويزيل تلقائياً غالبية الـ 3,897 ملف
`.map` الموجودة داخل `node_modules` (تعداد فعلي وقت التشخيص).

**التعديل المطلوب:** هذا **ليس تعديل كود** بل تعديل **خطوة بناء** — لا يوجد سطر Rust
يُعدَّل هنا. حدّد أين تُنشأ هذه المجلدات فعلياً (ابحث في `desktop/build-frontend.cmd` وأي
سكربت آخر — وقت كتابة هذه الخطة **لا توجد** خطوة صريحة تملأ `resources/node_modules` أو
`resources/backend/node_modules`؛ هي على الأرجح نُسخت يدوياً أو بسكربت غير موجود في الشجرة
الحالية — **تحقق أولاً بـ `git log --all --oneline -- desktop/src-tauri/resources` وابحث
عن أي سكربت `copy`/`robocopy`/`xcopy` لهذين المسارين بالتحديد قبل الكتابة فوقهما**، لضمان
عدم كسر خطوة بناء تعتمد عليهما لاحقاً).

الأسلوب الموصى به:
1. لنسخة backend: من مجلد `backend/` الحقيقي (مصدر البناء، وليس `resources/backend`)، نفّذ
   `npm install --omit=dev` في نسخة مؤقتة/منفصلة (لا تُفسِد `backend/node_modules` الأصلية
   المستخدَمة للتطوير)، ثم استبدل محتوى `resources/backend/node_modules` بناتج هذا التثبيت.
2. لنسخة `resources/node_modules` (العلوية، تخدم `ssr/serve.mjs`): الأصعب — هذه ليست نسخة
   backend ولا frontend عادية؛ يجب تحديد الحزم التي يستوردها فعلياً
   `resources/ssr/dist/server/server.js` وقت التشغيل (وليس وقت البناء عبر Vite/Rollup، لأن
   حزمة nitro/TanStack Start عادة تُضمِّن (bundle) معظم الاعتماديات داخل `server.js` نفسه
   وتترك القليل كـ "externals" فقط). نفّذ:
   ```powershell
   node --experimental-vm-modules -e "..." # أو أبسط:
   Select-String -Path desktop\src-tauri\resources\ssr\dist\server\server.js -Pattern 'from\s+"([^\.][^"]*)"' -AllMatches
   ```
   لاستخراج كل bare import غير نسبي داخل `server.js` المبني فعلياً، ثم أنشئ
   `resources/node_modules` بحيث يحتوي **فقط** هذه الحزم (+ تبعياتها التِعدِّية Transitive
   عبر `npm install <package>@<same-version-as-lockfile> --no-save` في مجلد مؤقت منفصل، أو
   عبر أداة تقليم متخصصة مثل `npm-prune`/`modclean` إن كانت مثبَّتة في بيئة التطوير).
3. **لا تحذف يدوياً حزمة بحزمة داخل `node_modules` الحالية** (مثل `rm -rf
   node_modules/eslint`) — هذا يترك ملفات `package-lock`/metadata غير متسقة وقد يكسر
   resolution؛ الأسلوب الصحيح هو دائماً **إعادة بناء المجلد من الصفر** بـ `npm install
   --omit=dev` أو ما يعادلها.

**كيف تتحقق من نجاح الإصلاح:**
1. بعد إعادة البناء، ابنِ MSI جديداً كاملاً (`npm run tauri:build` من `desktop/`).
2. شغّل الـ exe/MSI الناتج على جهاز اختبار نظيف (أو نفس الجهاز بعد إلغاء تثبيت أي نسخة
   سابقة).
3. دورة تحقق كاملة: إقلاع (تأكد من عدم ظهور أي حوار خطأ من المرحلتين 1-2 — إن ظهر أحدها،
   فهذا يعني أن حزمة ما زالت مطلوبة وقت التشغيل وحُذفت خطأً) → تسجيل دخول → أنشئ فاتورة
   جديدة → اطبعها (معاينة الطباعة تحديداً تعتمد على مسارات SSR/PDF قد تستورد حزم إضافية لم
   تُكتشَف من `server.js` وحده) → أغلق التطبيق وتأكد من إغلاق نظيف (لا عمليات `node.exe`/
   `postgres.exe` عالقة في Task Manager).
4. قارن حجم `resources/node_modules` و `resources/backend/node_modules` الجديد بالحجم
   القديم (350.0 MB / 141.7 MB) للتأكد من انخفاض فعلي ملموس.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 3.1-ب ⚠️ عطل حقيقي ناتج عن تنفيذ البند 3.1 — تعارض إصدارات `@tanstack/*` بين `resources/node_modules` وجذر المشروع

> **حالة هذا البند:** اكتُشِف بعد تنفيذ البند 3.1 فعلياً وتشغيل `runtime_probe.exe` كتحقق حي
> إضافي خارج نطاق المراحل الأربع (اختبار تشغيل كامل بعد كل الإصلاحات). **هذا ليس خطأ في
> منطق التوجيه العام للتطبيق ولا يمسّ نسخة الويب العادية (`npm run dev`) إطلاقاً** — محصور
> 100% بحزمة `resources/node_modules` المُغلَّفة لسطح المكتب. موثَّق هنا كدرس مستفاد ونقطة
> تحقق إلزامية لأي تنفيذ لاحق للبند 3.1، وكفجوة في التوصية الأصلية لذلك البند (التي لم تكن
> تتوقع هذا النمط من الأعطال تحديداً).

**الخطأ المُشاهَد فعلياً** (من `runtime_probe.exe` بعد اجتياز بصمة الجهاز + PostgreSQL +
الباك-إند بنجاح، عند وصول SSR):
```
TypeError: matchedRoutes is not iterable
    at handleServerRoutes (resources/ssr/dist/server/assets/server-WItCSSO7.js:1545:22)
```

**السبب الجذري (مثبَّت بدليل مباشر ملف:سطر، لا افتراضاً):**

تطبيق `@tanstack/react-start` (المُستخدَم في `src/router.tsx` و`src/start.ts`) يبني حزمة SSR
(`vite build` → `dist/server/server.js` وملحقاته) بأسلوب هجين: بعض الحزم **تُضمَّن (inline)**
داخل الحزمة النهائية وقت البناء (مثل `@tanstack/start-server-core` — دليل:
`dist/server/assets/server-WItCSSO7.js:26` يحمل تعليق
`//#region node_modules/@tanstack/start-server-core/dist/esm/request-response.js`)، بينما
حزم أخرى **تبقى استيرادات خارجية مُجرَّدة (bare imports)** تُحَل وقت التشغيل الفعلي عبر Node
بالصعود لأقرب `node_modules` (بالضبط كما يوثّق تعليق
`desktop/src-tauri/resources/ssr/serve.mjs:10-13` بنفسه).

الكود **المُضمَّن** (`start-server-core` 1.169.17، مُجمَّد وقت البناء) في
`server-WItCSSO7.js:1542,1545` (المصدر غير المُصرَّف:
`node_modules/@tanstack/start-server-core/src/createStartHandler.ts:768,778`) يتوقع:
```js
const { matchedRoutes, foundRoute, routeParams } = router.getMatchedRoutes(pathname);
for (const route of matchedRoutes) { ... }
```
أي **كائناً (object)** بخاصية `matchedRoutes`. وهذا فعلاً ما يُرجِعه `router-core` **في جذر
المشروع** (`node_modules/@tanstack/router-core/dist/esm/router.js:1095-1098`، الإصدار
**1.171.15**) — البيئتان متوافقتان تماماً في `npm run dev` لأنهما من نفس `npm install`
الوحيد.

لكن `router` الفعلي وقت تشغيل SSR المُحزَّم يُبنى عبر `createRouter()` من `@tanstack/react-router`
— وهذه **حزمة خارجية غير مُضمَّنة**، تُحَل من أقرب `node_modules` لملف
`resources/ssr/dist/server/assets/router-*.js`، وهو **`resources/node_modules`** — الذي
أعاد البند 3.1 بناءه بشكل مستقل (لا يوجد `package.json` داخل `resources/` أصلاً، فلا قفل
إصدار دقيق). النتيجة: `resources/node_modules/@tanstack/router-core` حمل الإصدار
**1.171.27** — وفي هذا الإصدار تغيّر شكل إرجاع `getMatchedRoutes()` إلى **مصفوفة (tuple)**:
`desktop/src-tauri/resources/node_modules/@tanstack/router-core/dist/esm/router.js:244-249`:
```js
this.getMatchedRoutes = (pathname) => {
    ...
    return [match?.branch || [this.routesById["__root__"]], /* rawParams */, /* foundRoute */];
};
```
فعندما ينفّذ الكود المُضمَّن (المتوقِّع كائناً) `const { matchedRoutes } = [مصفوفة, ...]`، تكون
النتيجة `matchedRoutes === undefined` (المصفوفات لا تملك خاصية `.matchedRoutes`) → `for (const
route of undefined)` → **`TypeError: matchedRoutes is not iterable`**، مطابق تماماً لتتبّع
الخطأ الأصلي سطراً بسطر.

**فحص شامل لكل الحزم الخارجية (وليس `router-core` فقط) — أُجري بمقارنة مباشرة لكل حزمة
مذكورة كاستيراد خارجي `bare import` في كامل `dist/server/assets/*.js` بين إصدار جذر المشروع
وإصدار `resources/node_modules`:**

| الحزمة | إصدار جذر المشروع (`node_modules/`) | إصدار `resources/node_modules/` | الحالة |
|---|---|---|---|
| `@tanstack/history` | 1.162.0 | 1.162.1 | ⚠️ مختلف |
| `@tanstack/react-query` | 5.101.4 | 5.102.8 | ⚠️ مختلف |
| `@tanstack/query-core` (تبعية لِ react-query) | 5.101.4 | 5.102.8 | ⚠️ مختلف |
| `@tanstack/react-router` | 1.170.18 | 1.170.32 | ⚠️ مختلف |
| `@tanstack/router-core` | 1.171.15 | 1.171.27 | ⚠️ مختلف — هذا سبب العطل المُشاهَد تحديداً |
| `@tanstack/react-store` (تبعية لِ react-router) | 0.9.3 | 0.9.3 | ✅ مطابق |
| `isbot` (تبعية لِ react-router) | 5.2.1 | 5.2.2 | ⚠️ مختلف |
| `cookie-es` (تبعية لِ router-core) | 3.1.1 | 3.1.1 | ✅ مطابق |
| `seroval` (تبعية لِ router-core، ويُستورَد مباشرة أيضاً في الحزمة المُضمَّنة) | 1.5.6 | 1.6.4 | ⚠️ مختلف |
| `seroval-plugins` (تبعية لِ router-core) | 1.5.6 | 1.6.4 | ⚠️ مختلف |
| `sonner` | 2.0.7 | 2.0.8 | ⚠️ مختلف |
| كل حزم `@radix-ui/react-*` (12 حزمة)، `react`, `react-dom`, `zod`, `clsx`, `tailwind-merge`, `class-variance-authority`, `h3-v2`, `lucide-react`, `recharts` | — | — | ✅ كلها مطابقة تماماً، لا خطر |
| `resources/backend/node_modules` بالكامل (فُحِص بشكل منفصل — لا يحتوي أي حزمة `@tanstack` إطلاقاً، وعينة من تبعياته الأساسية `zod`/`drizzle-orm`/`pg`/`express` كلها مطابقة لـ `backend/node_modules`) | — | — | ✅ لا خطر — بُني عبر `npm install` من `backend/package.json` الخاص به، مصدر واحد متسق، بعكس `resources/node_modules` العلوي الذي لا يملك `package.json` مصدرياً |

**9 حزم بالضبط تحتاج مزامنة دقيقة** (القائمة الكاملة، بما فيها التبعيات المتعدية):
`@tanstack/history`, `@tanstack/react-query`, `@tanstack/query-core`,
`@tanstack/react-router`, `@tanstack/router-core`, `isbot`, `seroval`, `seroval-plugins`,
`sonner`.

**لماذا لا يظهر في `npm run dev`:** بيئة التطوير العادية تستخدم `node_modules` الجذر **فقط**
لكل شيء — مصدر واحد متسق، كل الحزم من نفس عملية `npm install`. لا يوجد أي مسار فيها يصل لـ
`resources/node_modules` إطلاقاً. **هذا يعني أن المستخدمين الحاليين لنسخة الويب العادية غير
متأثرين بهذا العطل نهائياً — محصور بسياق SSR المُحزَّم لسطح المكتب فقط.**

**الدرس المستفاد (الأهم — يُطبَّق على أي إعادة بناء مستقبلية لـ `resources/node_modules`):**

> إعادة بناء `resources/node_modules` (أو أي مجلد اعتماديات مُغلَّف مشابه) **يجب أن تُثبِّت
> بالضبط نفس الإصدارات المُحلولة فعلياً بجذر المشروع (exact version match)، وليس "أحدث إصدار
> متوافق مع نطاق caret" وقت إعادة البناء.** السبب: أطر عمل مثل TanStack Start تُضمِّن
> (inline) بعض حزمها داخل الحزمة النهائية وقت البناء بينما تُبقي حزماً أخرى مرتبطة بها بشدة
> (مثل `router-core` مقابل `start-server-core`) كاستيرادات خارجية تُحَل وقت التشغيل — وشكل
> الواجهة البرمجية (API shape) بين هذين النوعين من الحزم قد يتغيّر بين إصدارات patch متتالية
> دون أي تحذير semver ظاهر (لأن الحزم المُضمَّنة والحزم الخارجية من نفس العائلة تُفتَرض دائماً
> أنها تُثبَّت وتُختبَر معاً من نفس التثبيت). أي فجوة زمنية بين "متى بُنيت الحزمة المُضمَّنة"
> و"متى أُعيد بناء مجلد الاعتماديات الخارجي" تفتح الباب لتعارض شكل بيانات صامت لا يظهر إلا وقت
> التشغيل الفعلي، لا وقت البناء (`cargo build`/`vite build` كلاهما ينجح بلا أي تحذير).

**الإصلاح المطلوب (للتنفيذ اللاحق، منفصل عن هذا التوثيق):** بدل الاعتماد على `npm install`
مستقل بنطاقات caret لبناء `resources/node_modules`، انسخ الحزم التسع أعلاه (كمجلدات كاملة)
مباشرة من `node_modules/<package>` (جذر المشروع) إلى
`desktop/src-tauri/resources/node_modules/<package>`، مستبدلاً ما هو موجود حالياً بالكامل —
هذا يضمن تطابقاً حرفياً 100% بدل الاعتماد على قفل إصدار في `package.json` قد لا يكون موجوداً
أصلاً (لا يوجد `package.json` داخل `resources/` حالياً). بعد النسخ، أعد بناء MSI كامل وكرّر
تشغيل `runtime_probe.exe` بنفس السيناريو للتأكد من اختفاء الخطأ ووصول SSR فعلياً لصفحة تسجيل
الدخول.

**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً/توجيهاً عاماً؟** لا — الإصلاح يقتصر بالكامل على
مزامنة إصدارات حزم داخل `resources/node_modules` المُغلَّفة لسطح المكتب فقط؛ لا تعديل على
`src/router.tsx` ولا أي ملف توجيه، ولا على نسخة الويب العادية.

---

### 3.2 حذف ملفات `.pdb` من `postgres/bin`
**الملف:** `desktop/src-tauri/resources/postgres/bin/*.pdb` (~30 ملفاً، مثل
`clusterdb.pdb`, `createdb.pdb`, `pg_dump.pdb`, `psql.pdb`, `pg_restore.pdb`, إلخ — القائمة
الكاملة مأخوذة من تعداد فعلي لمحتوى المجلد وقت التشخيص)
**المشكلة الحالية:** رموز تصحيح أخطاء (debug symbols) لأدوات PostgreSQL — لا تُقرَأ إطلاقاً
وقت التشغيل الطبيعي، فقط لو رُبِط debugger خارجي بعملية `postgres.exe` (سيناريو تطوير/تشخيص
عميق داخل فريق EDB نفسه، غير مستخدَم في هذا المشروع). ~40-45 ميجا.
**التعديل المطلوب:** حذف كل ملف بامتداد `.pdb` داخل `resources/postgres/bin/` فقط (لا تلمس
أي `.pdb` خارج هذا المسار إن وُجد). أمر PowerShell مرجعي:
```powershell
Get-ChildItem "desktop\src-tauri\resources\postgres\bin\*.pdb" | Remove-Item
```
**كيف تتحقق من نجاح الإصلاح:** ابنِ MSI جديداً، شغّل دورة كاملة (إقلاع → تسجيل دخول →
فاتورة → طباعة → إغلاق). ركّز خصوصاً على أن `postgres.exe` يبدأ ويستقبل اتصالات بشكل طبيعي
(حذف `.pdb` **لا يجب** أن يؤثر على تشغيل الـ `.exe` المقابل له إطلاقاً — إن ظهر أي خلل هنا
فهو على الأرجح غير مرتبط بهذا الحذف وينبغي التحقيق فيه بشكل منفصل).
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 3.3 حذف نسختين مكررتين من ICU (الإبقاء على النسخة المرتبطة فعلياً فقط)
**الملف:** `desktop/src-tauri/resources/postgres/bin/icu{dt,in,io,tu,uc}{67,68,75}.dll`
(15 ملفاً — 3 إصدارات كاملة من ICU: 67، 68، 75)
**المشكلة الحالية:** ثلاث نسخ كاملة من مكتبة ICU (بيانات دولية/يونيكود) مشحونة معاً.
`icudt67.dll` (28.4MB) + `icudt68.dll` (28.6MB) + `icudt75.dll` (30.7MB) وحدها = 87.7MB،
وبإضافة `icuin`/`icuio`/`icutu`/`icuuc` لكل إصدار يصل المجموع لنحو 104MB. `postgres.exe`
مبني ضد إصدار واحد فقط عملياً؛ الإصدارات الأخرى على الأرجح مخلَّفات من تجميع أدوات فرعية
(openssl/libxml2) بإصدارات ICU مختلفة داخل نفس مجلد `bin`.
**⚠️ لا تحذف بدون تحديد الإصدار الفعلي المُستخدَم أولاً — هذا البند الوحيد في هذه المرحلة
الذي يتطلب فحصاً قبل الحذف، وليس حذفاً مباشراً.**
**التعديل المطلوب:**
1. من "x64 Native Tools Command Prompt for VS" (متوفر أصلاً كتبعية بناء حسب
   `desktop/BUILD-WINDOWS.md`)، شغّل لكل ملف تنفيذي فعلي يُستدعى من الكود (حسب البند 2 من
   التشخيص الأصلي: `postgres.exe`, `pg_ctl.exe`, `initdb.exe`, `createdb.exe`، بالإضافة إلى
   `libpq.dll`):
   ```cmd
   dumpbin /imports "desktop\src-tauri\resources\postgres\bin\postgres.exe" | findstr /i icu
   dumpbin /imports "desktop\src-tauri\resources\postgres\bin\pg_ctl.exe"   | findstr /i icu
   dumpbin /imports "desktop\src-tauri\resources\postgres\bin\initdb.exe"   | findstr /i icu
   dumpbin /imports "desktop\src-tauri\resources\postgres\bin\createdb.exe" | findstr /i icu
   dumpbin /imports "desktop\src-tauri\resources\postgres\bin\libpq.dll"    | findstr /i icu
   ```
2. سجّل رقم(أرقام) الإصدار الظاهر(ة) فعلياً في هذه المخرجات (مثلاً `icuuc75.dll` فقط، أو
   قد يظهر أكثر من إصدار إن كانت الأدوات مبنية بأوقات مختلفة — في هذه الحالة أبقِ **كل**
   إصدار يظهر في أي من الأوامر الخمسة أعلاه).
3. احذف فقط الإصدارات (الـ 5 ملفات لكل رقم إصدار: `icudt`, `icuin`, `icuio`, `icutu`,
   `icuuc`) التي **لم تظهر إطلاقاً** في أي من مخرجات الخطوة 1.
4. إن تعذّر توفر `dumpbin` (خارج بيئة VS)، بديل: أبقِ فقط أحدث إصدار (75) واحذف 67 و68،
   بما أن الأحدث هو الأرجح أن يكون المرتبط فعلياً بالنسخة الحالية من postgres 17 — لكن هذا
   افتراض غير مؤكَّد بنفس درجة يقين `dumpbin`، **فضّل الخطوة 1-3 دائماً إن أمكن**.
**كيف تتحقق من نجاح الإصلاح:** بعد الحذف، ابنِ MSI جديداً وشغّل دورة كاملة. **الفشل هنا
سيكون فورياً وواضحاً بفضل المرحلة 1**: إن كان الإصدار المحذوف مطلوباً فعلاً، `postgres.exe`
سيفشل بالإقلاع فوراً ويظهر حوار "خطأ في تشغيل قاعدة البيانات" (البند 1.4) بدل اختفاء صامت —
هذا بالضبط سبب ترتيب هذه المرحلة بعد المرحلة 1. إن ظهر هذا الحوار، أعد الملفات المحذوفة
وراجع مخرجات `dumpbin` مجدداً.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 3.4 حذف أدوات PostgreSQL العميل غير المستخدَمة
**الملف:** `desktop/src-tauri/resources/postgres/bin/*.exe` (~30 ملفاً) + ملفات `.pdb`
المرافقة لها إن بقيت (يجب أن تكون محذوفة بالفعل بعد البند 3.2)
**المشكلة الحالية:** القائمة الكاملة (من تعداد فعلي لمحتوى المجلد): `clusterdb`,
`createuser`, `dropdb`, `dropuser`, `ecpg`, `oid2name`, `pg_amcheck`,
`pg_archivecleanup`, `pg_basebackup`, `pg_checksums`, `pg_combinebackup`, `pg_config`,
`pg_controldata`, `pg_createsubscriber`, `pg_dump`, `pg_dumpall`, `pg_isready`,
`pg_receivewal`, `pg_recvlogical`, `pg_resetwal`, `pg_restore`, `pg_rewind`,
`pg_test_fsync`, `pg_test_timing`, `pg_upgrade`, `pg_verifybackup`, `pg_waldump`,
`pg_walsummary`, `pgbench`, `psql`, `reindexdb`, `vacuumdb`, `vacuumlo`. الكود في
`desktop_runtime.rs` (تعداد كامل، البند 2 من التشخيص الأصلي) يستدعي فقط:
`postgres.exe`, `pg_ctl.exe`, `initdb.exe`, `createdb.exe`.

**⚠️ استثناء واحد مؤكَّد: لا تحذف `psql.exe`.** ملف `docs/DISASTER-RECOVERY.md:50` يوجّه
المستخدم صراحة لفتح "SQL Shell (psql)" كخطوة استرجاع كوارث — حتى لو كان هذا السطر مكتوباً
لسيناريو تثبيت PostgreSQL منفصل من `postgresql.org` (وليس بالضرورة `resources/postgres/bin`
المُغلَّف داخل الـ MSI تحديداً)، الأثر عند الخطأ (حذف أداة قد يحتاجها الدعم الفني يدوياً في
كارثة حقيقية) أكبر بكثير من الفائدة (psql.exe + pdb ≈ 3.5 ميجا فقط، لا تُذكَر مقارنة بـ
باقي البنود). **أبقِ psql.exe كإجراء احترازي إلى أن يؤكَّد صراحة أنه غير مطلوب في أي مسار
دعم فني للنسخة المُغلَّفة تحديداً.**

**التعديل المطلوب:**
1. **قبل أي حذف**، تحقق عبر `code-review-graph` أو بحث نصي مباشر أن كل اسم أداة من القائمة
   أعلاه (باستثناء `psql`) غير مذكور في أي مكان في الشجرة كاملة (وليس فقط
   `desktop/src-tauri/src`) — بما فيها التوثيق وسكربتات الدعم:
   ```
   code-review-graph search "<اسم-الأداة>"
   ```
   أو بحث نصي شامل (مثال لكل اسم، استبعد `resources/` و`node_modules/` من نطاق البحث حتى
   لا تُطابِق الملفات التنفيذية نفسها):
   ```
   grep -rn "pg_dump\|pg_restore\|pgbench\|vacuumdb\|reindexdb\|createuser\|dropdb\|dropuser\|ecpg\|oid2name\|pg_amcheck\|pg_archivecleanup\|pg_basebackup\|pg_checksums\|pg_combinebackup\|pg_config\|pg_controldata\|pg_createsubscriber\|pg_dumpall\|pg_isready\|pg_receivewal\|pg_recvlogical\|pg_resetwal\|pg_rewind\|pg_test_fsync\|pg_test_timing\|pg_upgrade\|pg_verifybackup\|pg_waldump\|pg_walsummary\|vacuumlo\|clusterdb" \
        --include="*.rs" --include="*.ts" --include="*.md" --include="*.bat" --include="*.cmd" \
        --include="*.ps1" . | grep -v "node_modules\|resources/postgres/bin"
   ```
2. أي اسم يظهر في نتيجة حقيقية (وليس مجرد تطابق جزئي عرضي) → استبعده من الحذف وثبّته في
   هذه الخطة كاستثناء إضافي.
3. احذف كل `.exe` (و`.pdb` المرافق إن بقي) لم يظهر في أي نتيجة بحث، **باستثناء `psql.exe`
   دائماً** بغض النظر عن نتيجة البحث.
**كيف تتحقق من نجاح الإصلاح:** ابنِ MSI جديداً، دورة كاملة (إقلاع → تسجيل دخول → فاتورة →
طباعة → إغلاق). بما أن هذه الأدوات غير مستدعاة برمجياً على الإطلاق (تأكدنا في التشخيص
الأصلي عبر تعداد كل `Command::new()` في الكود)، **لا يُفترض** ظهور أي حوار خطأ من المرحلتين
1-2 نتيجة هذا الحذف تحديداً — إن ظهر، فهذا يعني أن أداة ما مُستخدَمة بطريقة غير متوقَّعة
(مثل تشغيلها من سكربت خارج هذا الـ crate) ويجب التحقيق قبل المتابعة.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 3.5 حذف `stackbuilder.exe` وملفات `wx*.dll` المرتبطة
**الملف:**
`desktop/src-tauri/resources/postgres/bin/stackbuilder.exe`,
`desktop/src-tauri/resources/postgres/bin/wxbase3210u_net_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxbase3210u_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxbase3210u_xml_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxmsw3210u_adv_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxmsw3210u_aui_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxmsw3210u_core_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxmsw3210u_html_vc_x64_custom.dll`,
`desktop/src-tauri/resources/postgres/bin/wxmsw3210u_xrc_vc_x64_custom.dll`
**المشكلة الحالية:** `stackbuilder.exe` هو أداة EDB الرسومية التفاعلية ("Application Stack
Builder") لتثبيت إضافات PostgreSQL يدوياً عبر واجهة Windows — لا علاقة لها بتشغيل خادم مُشغَّل
بلا تدخل بشري (headless). ملفات `wx*.dll` هي مكتبة واجهة الرسوميات (wxWidgets) التي يعتمد
عليها `stackbuilder.exe` حصرياً — لا يستخدمها `postgres.exe`/`pg_ctl.exe`/`initdb.exe`/
`createdb.exe` إطلاقاً. المجموع ≈ 14.2 ميجا.
**التعديل المطلوب:** احذف الملفات التسعة المذكورة أعلاه بالضبط.
**كيف تتحقق من نجاح الإصلاح:** ابنِ MSI جديداً، دورة كاملة (إقلاع → تسجيل دخول → فاتورة →
طباعة → إغلاق). لا يُفترض أي تأثير — `stackbuilder.exe` غير مذكور في أي `Command::new()` في
الكود (مؤكَّد في التشخيص الأصلي).
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

## المرحلة 4: تنظيف عام (منخفض الخطورة، يُنفَّذ أخيراً)

**لماذا أخيراً:** هذه البنود لا تؤثر على سلوك التطبيق وقت التشغيل إطلاقاً (توثيق، إعدادات
بناء، نظافة مستودع git) — لا فائدة من تعريض نفسها لمخاطر ترتيب التنفيذ مع البنود الوظيفية
أعلاه؛ الأصح تأجيلها لآخر جلسة عمل بعد التأكد من استقرار المراحل 1-3.

### 4.1 مسار مطلق ثابت في `beforeBuildCommand`
**الملف:** `desktop/src-tauri/tauri.conf.json:10`
**المشكلة الحالية:**
```json
    "beforeBuildCommand": "cmd /c C:\\Users\\Taw\\Downloads\\Compressed\\q\\ME-main\\desktop\\build-frontend.cmd"
```
مسار مطلق مرتبط بجهاز/حساب مستخدم واحد بالضبط — `tauri build` لن يعمل على أي جهاز آخر (بيئة
CI، حاسوب مطوّر آخر، جهاز التوقيع الرقمي النهائي) بدون تعديل هذا الملف يدوياً أولاً.
**التعديل المطلوب:** استبدله بمسار نسبي إلى جذر تشغيل `tauri build` نفسه. حسب التعليق داخل
`build-frontend.cmd` نفسه ("Invoked by tauri.conf.json beforeBuildCommand (which runs it
via cmd with the cwd wherever tauri build was started..."), الأسلم هو استخدام `%~dp0`
النسبي لموقع `tauri.conf.json` بدل الاعتماد على `cwd` وقت التشغيل:
```json
    "beforeBuildCommand": "cmd /c \"%~dp0..\\build-frontend.cmd\""
```
**ملاحظة:** `%~dp0` تعمل فقط داخل ملف `.bat`/`.cmd` يُنفَّذ مباشرة، وليس كتعبير مباشر داخل
`cmd /c "..."` من سطر أوامر خارجي بهذا الشكل تحديداً — تحقق عملياً من أن Tauri يمرّر هذا
السطر إلى `cmd.exe` بطريقة تدعم `%~dp0` (قد تحتاج بدلاً من ذلك كتابة سكربت `.cmd` صغير في
مسار ثابت نسبي لملف `tauri.conf.json` نفسه، مثل `desktop/src-tauri/before-build.cmd`،
محتواه:
```bat
@echo off
call "%~dp0..\build-frontend.cmd"
```
ثم في `tauri.conf.json`:
```json
    "beforeBuildCommand": "cmd /c before-build.cmd"
```
هذا أكثر ضماناً لأن `tauri.conf.json` نفسه يحدد `cwd` كمجلد `src-tauri` عادة عند تشغيل
`tauri build` من `desktop/`.) **جرّب الأسلوبين وتحقق أيهما فعلياً يعمل قبل الاستقرار على
واحد.**
**كيف تتحقق من نجاح الإصلاح:** انسخ المستودع بالكامل إلى مسار مختلف تماماً (مثلاً
`D:\test-build\ME-main` بدل `C:\Users\Taw\Downloads\Compressed\q\ME-main`)، وشغّل
`npm run tauri:build` من هناك — يجب أن ينجح البناء بلا أي تعديل يدوي على `tauri.conf.json`.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 4.2 إضافة `desktop/src-tauri/resources/` إلى `.gitignore`
**الملف:** `.gitignore` (جذر المستودع)
**المشكلة الحالية:** السطور 68-69 الحالية تستثني فقط:
```
desktop/src-tauri/target/
desktop/node_modules/
```
لا يوجد استثناء لـ `desktop/src-tauri/resources/` (حالياً >1GB، غير مُتتبَّعة فقط لأنها لم
تُضَف بـ `git add` بعد — وليس بسبب أي قاعدة gitignore). أي `git add -A`/`git add .` مستقبلي
سيحاول تتبع كامل شجرة postgres/node_modules/backend المُغلَّفة.
**التعديل المطلوب:** أضف بعد السطر 69 مباشرة:
```
desktop/src-tauri/resources/
desktop/src-tauri/Cargo.lock
desktop/src-tauri/gen/
desktop/package-lock.json
desktop/pnpm-lock.yaml
```
**ملاحظة:** `Cargo.lock` لتطبيق قابل للتنفيذ (`[[bin]]`) يُفضَّل عادة تتبّعه في git لضمان
بناءات قابلة لإعادة الإنتاج (reproducible builds) — لكن بما أنه غير متتبَّع أصلاً حالياً
وهذا خارج نطاق هذه الخطة (قرار سياسة مستودع، ليس إصلاح تغليف)، أدرجه هنا في `.gitignore`
فقط لمنع تتبّعه **عرضياً** عبر `git add -A`؛ إن قرر صاحب المشروع لاحقاً تتبّعه عمداً،
يستخدم `git add -f desktop/src-tauri/Cargo.lock` تحديداً بدل الاعتماد على `git add -A`.
**كيف تتحقق من نجاح الإصلاح:** بعد التعديل، `git status` من جذر المستودع — يجب ألا تظهر
أي من المسارات أعلاه في قسم `Untracked files` بعد الآن. جرّب أيضاً `git add -A` (بدون
commit) و `git status` مجدداً للتأكد أنه لا يحاول تتبّع أي ملف داخل `resources/`.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 4.3 حذف `probe_load.obj` و `extracted_fix/` من شجرة `src-tauri`
**الملف:**
`desktop/src-tauri/probe_load.obj` (3,241 بايت، ملف object مترك من بناء سابق)
`desktop/src-tauri/target/release/bundle/msi/extracted_fix/` (محتوى MSI مُستخرَج يدوياً
لتشخيص سابق — `Binary/`, `File/`, `Icon/`)
**المشكلة الحالية:** ملفات مؤقتة/تشخيصية متروكة في شجرة العمل، لا تخدم أي غرض في البناء أو
التشغيل.
**التعديل المطلوب:** احذف كليهما:
```powershell
Remove-Item "desktop\src-tauri\probe_load.obj"
Remove-Item -Recurse "desktop\src-tauri\target\release\bundle\msi\extracted_fix"
```
(المسار الثاني داخل `target/` أصلاً مستثنى بـ `.gitignore` — هذا تنظيف قرص محلي فقط، لا
علاقة له بـ git.)
**كيف تتحقق من نجاح الإصلاح:** `cargo build` بعد الحذف يجب أن ينجح بلا أي مرجع مفقود لـ
`probe_load.obj` (إن فشل البناء بعد حذفه، فهذا يعني أنه كان مُستخدَماً فعلياً في مكان ما —
ابحث عن مرجع له في `Cargo.toml`/`build.rs` قبل حذفه نهائياً في هذه الحالة). حذف
`extracted_fix/` لا يحتاج أي تحقق بناء لأنه ليس جزءاً من مدخلات البناء إطلاقاً — فقط تأكد
أن بناء MSI جديد كامل ينجح وينتج ملف MSI صحيح كالمعتاد.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 4.4 تحديث `BUILD-WINDOWS.md` ليطابق الإعداد الفعلي
**الملف:** `desktop/BUILD-WINDOWS.md:49-51` و `:147-163`
**المشكلة الحالية:**
- السطور 49-51 تذكر مخرجات `nsis/*.exe` و `*.exe` (portable) كمخرجات بناء متوقَّعة، لكن
  `tauri.conf.json:32` الحالي يحدد `"targets": ["msi"]` فقط — لن يُنتَج أي منهما.
- السطور 147-163 تشرح تفعيل "Auto-Update" عبر `tauri-plugin-updater` وقسم `"plugins":
  {"updater": ...}` في `tauri.conf.json` — لكن `Cargo.toml` الحالي **لا** يتضمن
  `tauri-plugin-updater` كتبعية، ولا يوجد قسم `plugins` في `tauri.conf.json` الحالي.
**التعديل المطلوب:**
1. في جدول "مخرجات البناء" (بعد السطر 45)، احذف الصفين الخاصين بـ `nsis/*.exe` و
   `*.exe` (portable)، أبقِ فقط صف `msi/*.msi`. أضف ملاحظة:
   ```markdown
   > ملاحظة: `tauri.conf.json` الحالي يحدد `"targets": ["msi"]` فقط. لتفعيل NSIS أو
   > exe محمول، أضف `"nsis"` أو `"app"` إلى مصفوفة `bundle.targets` أولاً.
   ```
2. في قسم "التحديث التلقائي (Auto-Update)" (السطر 147 فما بعد)، أضف في البداية:
   ```markdown
   > **⚠️ غير مُفعَّل حالياً.** `Cargo.toml` الحالي لا يتضمن تبعية `tauri-plugin-updater`،
   > و`tauri.conf.json` لا يحتوي قسم `plugins`. الخطوات أدناه توضيحية لتفعيله **مستقبلاً**
   > فقط — تتطلب أولاً إضافة `tauri-plugin-updater = "2"` إلى `[dependencies]` في
   > `Cargo.toml` وتسجيله في `main.rs` عبر `.plugin(tauri_plugin_updater::Builder::new().build())`.
   ```
**كيف تتحقق من نجاح الإصلاح:** هذا تعديل توثيق بحت — لا بناء أو تشغيل مطلوب للتحقق. اقرأ
الملف بعد التعديل وتأكد أنه لا يوجد تناقض متبقٍ بين ما يصفه وما هو فعلياً في
`tauri.conf.json`/`Cargo.toml` الحاليين وقت التعديل (أعد فتح كلا الملفين وقارن يدوياً).
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

### 4.5 تضييق CSP `connect-src`
**الملف:** `desktop/src-tauri/tauri.conf.json:27`
**المشكلة الحالية:**
```json
"csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://* ws://127.0.0.1:*"
```
`connect-src` يتضمن `https://*` — يسمح بالاتصال من الواجهة (webview) إلى **أي** نطاق HTTPS
في العالم، رغم أن كل حركة مرور التطبيق الفعلية تقتصر على `127.0.0.1` (الـ backend والـ SSR
كلاهما محليان حسب التتبع الكامل في التشخيص). هذا لا علاقة له مباشرة بالتغليف/الحجم، لكنه
"نمط مشابه" (افتراض بيئة غير مضبوط بدقة) اكتُشِف أثناء الفحص العام (البند 6 من التشخيص
الأصلي).
**التعديل المطلوب:**
```json
"csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"
```
(حذف `http://localhost:*` و `https://*` بالكامل). **تحذير مهم قبل التنفيذ:** تحقق أولاً هل
يوجد أي استدعاء فعلي من كود الواجهة (`src/` في جذر المستودع، المُبنى وقت `build-frontend.cmd`
إلى `dist/` ثم `ssr/dist/`) إلى نطاق HTTPS خارجي وقت التشغيل الفعلي (مثل خط أساس ترخيص خارجي،
أو مكتبة خطوط/تحليلات). ابحث عن `fetch(` و `axios` و `XMLHttpRequest` في `src/` مع أي رابط
`https://` غير `fonts.googleapis.com`/`fonts.gstatic.com` (تلك مغطاة بقواعد CSP أخرى مسبقاً
ولا تحتاج `connect-src`). إن وُجد استخدام حقيقي، أضف نطاقه تحديداً بدل حذف `https://*` بالكامل.
**كيف تتحقق من نجاح الإصلاح:** بعد التعديل وإعادة البناء، شغّل دورة كاملة (إقلاع → تسجيل
دخول → فاتورة → طباعة). افتح أدوات المطوّر داخل الـ webview (إن كانت مفعَّلة في بناء
التطوير) وراقب أي رسالة "Refused to connect... violates Content Security Policy" في وحدة
التحكم — ظهور أي رسالة كهذه يعني أن نطاقاً حقيقياً كان يُستخدَم وحُذِف خطأً، ويجب إضافته
صراحة بدل استعادة `https://*`.
**هل يمس منطقاً تجارياً/محاسبياً/ترخيصاً؟** لا

---

## ترتيب التنفيذ الموصى به

```
البند 0 (المرحلة 1)
   │  show_fatal_dialog يجب أن تكون pub أولاً — كل شيء آخر يعتمد عليها
   ▼
البنود 1.1 → 1.8 (المرحلة 1، أي ترتيب داخلي بينها جائز، لكن يُفضَّل بالترتيب المكتوب
لأنه يتبع تسلسل الإقلاع الفعلي: device-binding قبل pgdata قبل postgres قبل backend قبل SSR)
   │  الآن كل مسار فشل معروف يُظهر حواراً — أي عطل لاحق (من المرحلتين 2 أو 3) سيكون
   │  قابلاً للتشخيص فوراً بدل اختفاء صامت
   ▼
البند 2.1 (توحيد app_data_dir) — يجب أن يسبق 2.3 لأن 2.3 يعتمد على أن
BootConfig::for_app أصبحت Result
   ▼
البند 2.2 (main.rs:26) — مستقل عن 2.1/2.3، يمكن قبلهما أو بعدهما، لكن الأبسط تنفيذه
بعد 2.1 لأن كلاهما يعدّل نفس منطقة main.rs المبكرة في جلسة عمل واحدة متصلة
   ▼
البند 2.3 (main.rs:33 + main.rs:34) — يعتمد إلزامياً على 2.1 (BootConfig::for_app
يجب أن تكون Result<Self, String> أولاً)
   │  الآن main.rs بالكامل خالٍ من .expect()/.unwrap() في مسار الإقلاع الحرج، وكل
   │  الأخطاء المحتملة (device binding، Tauri builder، resource_dir، BootConfig،
   │  boot_desktop_stack بكل فروعه) تظهر كحوار عربي واضح
   ▼
المرحلة 3 بالكامل — يجب أن تأتي بعد المرحلتين 1 و2 كاملتين ومُختبَرتين، لأن الهدف من
هذا الترتيب هو بالضبط: أي كسر وظيفي ينتج عن حذف ملف تغليف (مثل حذف إصدار ICU خطأً في
البند 3.3) يجب أن يُشخَّص فوراً عبر حوار خطأ واضح (البند 1.4 تحديداً)، لا انهياراً
صامتاً يتطلب إعادة تشخيص كاملة من الصفر لمعرفة أي ملف محذوف تحديداً سبب المشكلة.
داخل المرحلة 3 نفسها:
   3.1 (npm prune) أولاً — الأثر الأكبر، ومستقل تماماً عن بقية بنود postgres/bin
   3.2 (.pdb) → 3.3 (ICU) → 3.4 (أدوات العميل) → 3.5 (stackbuilder) بهذا الترتيب
   تحديداً، لأن كل بند يجب أن يُبنى ويُختبَر بمفرده (MSI جديد + دورة كاملة) قبل
   الانتقال للتالي — لا تجمع بنود 3.2-3.5 في تعديل واحد أبداً
   ▼
المرحلة 4 — لا تعتمد على أي شيء آنف الذكر وظيفياً، لكن الأصح تأجيلها لآخر جلسة عمل
لأنها لا تضيف قيمة تشخيصية للمراحل السابقة (بند 4.5 وحده يستحق ملاحظة: نفّذه بعد
استقرار كل شيء آخر لأنه الوحيد القادر على كسر شيء يعمل فعلياً — وهو بالتحديد سبب
كونه آخر بند في كامل الخطة)
```

**قاعدة عامة لكل الخطة:** لا تنتقل لمرحلة تالية إلا بعد `cargo build` ناجح + دورة اختبار
كاملة (إقلاع → تسجيل دخول → فاتورة → طباعة → إغلاق نظيف بلا عمليات عالقة) للمرحلة الحالية.
