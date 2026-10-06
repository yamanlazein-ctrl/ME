# خطة عمل: الرصيد الافتتاحي + ترويسة الفاتورة + الطباعة المباشرة

- **تاريخ الإعداد:** 2026-10-05
- **الحالة (2026-10-06):** نُفّذت المهام الثلاث في الكود واجتازت فحوص SQLite والواجهة. بقي ما يحتاج PostgreSQL: مجموعة `npm test`، وإعادة توليد بصمة PG من قاعدة حية (عُدّلت يدوياً بنفس الخوارزمية)، و`verify-sync-multidevice`، إضافة إلى الفحص اليدوي للطباعة. انحراف مقصود عن 2.3/الخطوة 7–8: مسار `PUT …/:id/opening` يُزامَن كعملية `party/update` مدخلها `{ opening }`، فيمرّ بنفس فحص `baseVersion` والتعارضات بدل فرع مزامنة جديد.
- **الفرع:** `clean-desktop-release`
- **المعمارية (ثابتة، لا تتغير):** Tauri (Rust) + React + Node/Express، مع SQLite محلياً وNamed Pipe، وPostgreSQL في المركز السحابي للمزامنة. المشروع **ليس Electron**.

---

## 0. قواعد إلزامية قبل أي تعديل

1. في شجرة العمل حوالي 372 تغييراً غير محفوظ، معظمها من عمل محرك SQLite وتعديلات أخرى قائمة. **لا يُمسّ أي منها**: لا `reset` ولا `stash` ولا `checkout` ولا إعادة كتابة ملف كامل. التعديل يكون **سطراً بسطر** فقط.
2. خذ لقطة احتياطية قبل البدء:
   ```bash
   git diff --binary > <scratch>/before-plan.patch
   git ls-files --others --exclude-standard -z > <scratch>/untracked.list0
   ```
3. لا يتغير منطق توليد PDF، ولا تتغير المزامنة خارج ما هو مذكور هنا.
4. سلامة القيود المالية فوق كل اعتبار: جدول `ledger_entries` لا يقبل الحذف، والتعديل الوحيد المسموح هو الإلغاء (`status → cancelled`) بقيد قاعدة البيانات نفسها. انظر `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql`، المُشغّلان `trg_ledger_entries_append_only_bd` و`trg_ledger_entries_append_only_bu`، والدالة المقابلة في PostgreSQL `fn_ledger_entries_append_only`.

---

## 1. القرارات المعتمدة

| # | القرار |
|---|---|
| ق1 | **رصيد افتتاحي واحد لكل طرف**، بعملة يختارها المستخدم (SYP أو USD)، وقد تختلف عن العملة الافتراضية للطرف. |
| ق2 | **يُسمح بتعديل الرصيد الافتتاحي** حتى بعد وجود فواتير أو سندات. يتم ذلك بإلغاء القيد القديم (يبقى ظاهراً كملغى للتدقيق) وتسجيل قيد جديد، في معاملة واحدة. لا حذف أبداً. |
| ق3 | يُرفض الإنشاء أو التعديل إذا وقع تاريخ القيد القديم أو الجديد في **سنة مالية مُقفلة** (`assertYearOpen`). |
| ق4 | الطباعة المباشرة: أسود صريح على الورق، والشعار مضمَّن Base64، وانتظار تحميل الصور قبل الطباعة. انقطاع الطابعة نفسها على مستوى Windows لا يستطيع التطبيق التحكم به. |

---

## 2. المهمة الأولى: الرصيد الافتتاحي

### 2.1 ما وُجد في الفحص

- **الموجود ويعمل:** عند إنشاء الطرف يُسجَّل قيد افتتاحي **متوازن من سطرين** عبر `openingJournalRows()`:
  - سطر على حساب الطرف من نوع `opening`، وسطر مقابل في حقوق الملكية من نوع `opening_equity`.
  - `referenceType = "opening"` و`referenceId = partyId`.
  - الإشارة: العميل الموجب مدين (Dr)، والمورد الموجب دائن (Cr).
  - يظهر القيد في كشف الحساب بتسمية `الرصيد الافتتاحي` (SqliteStatementRepository، السطر 39).
- **المزامنة الحالية:** يحمل `snapshot` إنشاء الطرف `openingBalance` و`openingDate` (الدالة `withPartyOpening` في `syncUseCases.ts`). يكرّر المركز القيد مرة واحدة عبر `applyPartyOpeningForReplay` ثم `applyPartyOpening` في `Postgres/SqliteSyncDependencyStore.ts`. فحص "مرة واحدة" يعتمد على وجود سطر `referenceType='opening'` لنفس `referenceId`.

**النواقص (مؤكدة بالكود):**
1. **الواجهة** (`src/components/parties/PartyFormDialog.tsx`، السطور 196 إلى 200 و440 إلى 455):
   - حقل رقم واحد بإشارة مربكة: الموجب "لنا" للعميل و"له" للمورد.
   - لا عملة ولا نوع (له/لنا) ولا تاريخ ولا ملاحظات.
   - الحقل معطَّل في التعديل، ولا يُرسَل في التعديل أصلاً.
2. **حقول ميتة:** المخطط المشترك (`packages/shared/src/schemas/party.schema.ts`، السطور 4 إلى 6 و39 إلى 44) والمنفذ (`backend/src/application/ports/IPartyRepository.ts`، السطور 34 إلى 38) يعرّفان `openingAmount` و`openingDirection` (`they_owe_us` | `we_owe_them`) و`openingDate` و`openingNote`، **ولا يقرؤها أي كود في الباك إند**.
3. **القيد يُؤرَّخ دائماً بتاريخ اليوم** (`date: localToday()` في `create`)، ويُسجَّل **بعملة الطرف** فقط، و**الملاحظة لا تُحفَظ**. العمودان `parties.opening_date` و`parties.opening_note` **موجودان** في المخططين ولا يُكتبان.
4. **التعديل مرفوض كلياً** برسالة `لا يمكن تعديل الرصيد الافتتاحي بعد الإنشاء`:
   - `backend/src/infrastructure/repositories/PostgresPartyRepository.ts:452`
   - `backend/src/infrastructure/repositories/sqlite/SqlitePartyRepository.ts:453`
5. **لا يوجد عمود لعملة الرصيد الافتتاحي** في جدول `parties`. شاشة تفاصيل الطرف (`src/components/parties/PartyDetails.tsx:623`) تعرض `openingBalance` بعملة الطرف، فيكون العرض خاطئاً إذا اختلفت العملة.

### 2.2 الملفات المعنية

| الطبقة | الملف | ما سيتغير |
|---|---|---|
| مخطط مشترك | `packages/shared/src/schemas/party.schema.ts` | إضافة `openingCurrency` (SYP/USD، اختياري). استخدام الحقول الموجودة كما هي. |
| واجهة | `src/components/parties/PartyFormDialog.tsx` | حقول المبلغ والعملة والنوع (له/لنا) والتاريخ والملاحظات، مفعّلة في الإنشاء والتعديل. |
| واجهة | `src/components/parties/PartyDetails.tsx` | عرض الرصيد الافتتاحي بعملته الصحيحة وتاريخه وملاحظته. |
| واجهة (DTO/نطاق) | `src/core/dtos/PartyDTO.ts`، `src/domain/entities/Party.ts`، `src/infrastructure/repositories/api/ApiPartyRepository.ts`، `src/presentation/hooks/useParties.ts` | تمرير الحقول الجديدة. |
| منفذ ونطاق | `backend/src/application/ports/IPartyRepository.ts`، `backend/src/domain/entities/Party.ts` | `openingCurrency`، وتوقيع دالة التعديل الجديدة. |
| حالة الاستخدام | `backend/src/application/use-cases/parties/partyUseCases.ts` | تحويل (المبلغ + النوع) إلى إشارة صحيحة حسب نوع الطرف، والتحقق (مبلغ ≥ 0، رقمان عشريان، تاريخ صالح). |
| مسار HTTP | `backend/src/presentation/routes/party.route.ts` (والمخطط المصاحب) | مسار تعديل الرصيد الافتتاحي (انظر 2.3، الخطوة 6). |
| مستودع PG | `backend/src/infrastructure/repositories/PostgresPartyRepository.ts` | `create` يستخدم التاريخ والعملة والملاحظة. دالة جديدة `setOpening(...)`. `openingJournalRows` يقبل الملاحظة. |
| مستودع SQLite | `backend/src/infrastructure/repositories/sqlite/SqlitePartyRepository.ts` | نفس التغييرات بالضبط. |
| مخطط PG | `backend/src/infrastructure/orm/schemas/party.table.ts` + ترحيل جديد `backend/src/infrastructure/orm/migrations/2026XXXX_party_opening_currency.sql` + `meta/_journal.json` | عمود `opening_currency varchar(3)` قابل لـ NULL (NULL يعني عملة الطرف، توافقاً مع البيانات القديمة). |
| مخطط SQLite | `backend/src/infrastructure/orm/sqlite/schemas/party.table.ts` + ترحيل `backend/src/infrastructure/orm/sqlite/migrations/0004_party_opening_currency.sql` + `meta/_journal.json` + `meta/schema-fingerprint.json` | نفس العمود، ثم إعادة توليد البصمة (`npm run typecheck:sqlite` يتحقق منها). |
| مزامنة | `backend/src/application/use-cases/sync/syncCoverage.ts` | تسجيل مسار التعديل الجديد كعملية مزامنة. |
| مزامنة | `backend/src/application/use-cases/sync/syncUseCases.ts` (`withPartyOpening`) | إضافة `openingCurrency` و`openingNote` إلى `snapshot` الإنشاء. |
| مزامنة | `backend/src/application/use-cases/sync/syncDependencySnapshots.ts` (`SyncPartySnapshot`، `applyPartyOpeningForReplay`) | تمرير العملة والملاحظة. |
| مزامنة | `backend/src/application/use-cases/sync/syncMaterialize.ts` | فرع تطبيق جديد لعملية تعديل الرصيد الافتتاحي. |
| مزامنة | `backend/src/application/ports/ISyncDependencyStore.ts`، `backend/src/infrastructure/repositories/PostgresSyncDependencyStore.ts`، `backend/src/infrastructure/repositories/sqlite/SqliteSyncDependencyStore.ts` | `applyPartyOpening` يستخدم عملة القيد وملاحظته بدل عملة الطرف. |

### 2.3 خطوات التنفيذ بالترتيب

1. **اللقطة الاحتياطية** (القسم 0).
2. **عمود العملة:** ترحيل PG وSQLite يضيف `opening_currency` (NULL = عملة الطرف). حدّث المخططين والـ journal وبصمة SQLite. تحقق بـ `npm run typecheck:sqlite` و`npm run db:check`.
3. **المخطط المشترك:** أضف `openingCurrency`. الحقول الأخرى موجودة وتبقى كما هي، مع الإبقاء على `openingBalance` للتوافق مع العملاء الأقدم.
4. **حالة الاستخدام (الإنشاء):**
   - إذا وصل `openingAmount` و`openingDirection` يُحسب الرقم الموقَّع:
     - للعميل: `they_owe_us` موجب، و`we_owe_them` سالب.
     - للمورد: `we_owe_them` موجب، و`they_owe_us` سالب.
     - هذا مطابق تماماً لاصطلاح `openingJournalRows` الحالي، فلا تغيير في القيد نفسه.
   - العملة الافتراضية = عملة الطرف، والتاريخ الافتراضي = اليوم المحلي.
   - استدعِ `assertYearOpen(tx, tenantId, openingDate)`.
5. **المستودعان (الإنشاء):**
   - مرّر `date = openingDate` و`currency = openingCurrency ?? party.currency`.
   - الوصف: `الرصيد الافتتاحي` أو `الرصيد الافتتاحي — <الملاحظة>`.
   - اكتب `opening_balance` و`opening_date` و`opening_note` و`opening_currency` في `parties`.
6. **التعديل (الجديد):** دالة `setOpening(partyId, {amount, direction, currency, date, note}, ctx, expectedVersion)` في المستودعين، داخل **معاملة واحدة**:
   1. تحقق من `expectedVersion` بنفس آلية التعديل الحالية لمنع الكتابة فوق تعديل أحدث.
   2. اقرأ سطري القيد الافتتاحي **الفعّالين** (`referenceType='opening'` و`referenceId=partyId` و`status='active'`).
   3. `assertYearOpen` لتاريخ القيد القديم والجديد معاً.
   4. ألغِ السطرين القديمين: `UPDATE ... SET status='cancelled'` فقط، وهو التعديل الوحيد الذي يسمح به المُشغّل. أعد استخدام نمط إلغاء القيود الموجود في الفواتير والسندات، ولا تكتب منطقاً جديداً.
   5. إذا كان المبلغ الجديد ≠ 0، أدرج قيداً متوازناً جديداً بـ `openingJournalRows` بالعملة والتاريخ والملاحظة الجديدة.
   6. حدّث أعمدة `opening_*` وزِد `version`.
   7. اكتب سجل تدقيق بالقيمة القديمة والجديدة والمستخدم، عبر آلية `audit_logs` الموجودة.
   - احذف الرفض الحالي (TX6) في `update()` **فقط** بعد أن يصبح التعديل يمر عبر `setOpening`. يبقى `update()` العادي لا يقبل حقول الرصيد، ويوجّهها إلى المسار الجديد.
7. **المسار والواجهة البرمجية:**
   - `PUT /customers/:id/opening` و`PUT /suppliers/:id/opening`، بنفس حراسة الصلاحيات ومفتاح `Idempotency-Key` المتبعين في `party.route.ts`.
   - سجّلهما في `syncCoverage.ts` كـ `{ entityType: "party", operation: "opening" }`.
8. **المزامنة:**
   - **الإنشاء:** أضف `openingCurrency` و`openingNote` إلى `snapshot` (`withPartyOpening` و`SyncPartySnapshot`). يستخدمهما `applyPartyOpening` في المخزنين. يبقى فحص "مرة واحدة" كما هو.
   - **التعديل:** فرع في `syncMaterialize.ts` لـ `party` / `opening`:
     - يستدعي **نفس** `setOpening` على المركز.
     - يتحقق من `baseVersion` كباقي تعديلات الأطراف.
     - تكرار الإرسال يُكتشف بـ `op_id` في الـ inbox.
     - تعديلان متزامنان من جهازين يُرفض الثاني كتعارض عادي يظهر في `sync_conflicts`. لا دمج صامت.
   - **السحب** يطبّق نفس الفرع على الأجهزة الأخرى.
9. **الواجهة:**
   - في `PartyFormDialog.tsx` قسم "الرصيد السابق" يضم: مبلغ، عملة (SYP/USD)، نوع ("له / دائن" أو "لنا / مدين")، تاريخ، ملاحظات.
   - في الإنشاء تُرسَل الحقول مع الطرف. في التعديل يُستدعى المسار الجديد **فقط إذا تغيّرت قيم الرصيد**، مع رسالة تأكيد تقول: "سيُلغى القيد السابق ويُسجَّل قيد جديد، ويبقى القديم ظاهراً ملغى في كشف الحساب".
   - في `PartyDetails.tsx`: العرض بالعملة الصحيحة.
10. **الاختبارات** (القسم 2.4)، ثم مراجعة `git diff` سطراً بسطر.

### 2.4 الفحص والاختبار

- **اختبارات وحدة جديدة** في `backend/tests/sqlite/` و`backend/tests/`:
  - تحويل النوع إلى إشارة: 4 حالات (عميل ومورد × له ولنا).
  - توازن القيد: مجموع المدين = مجموع الدائن، في الإنشاء والتعديل.
  - تاريخ وعملة وملاحظة القيد كما أُدخلت.
  - التعديل: السطران القديمان `cancelled` والجديدان `active`، والرصيد النهائي = الجديد فقط، وكشف الحساب يعرض القديم ملغى.
  - تعديل إلى صفر: إلغاء دون قيد جديد.
  - سنة مقفلة: رفض دون أي تغيير.
  - `expectedVersion` قديم: رفض 409.
  - تكرار نفس الطلب بنفس `Idempotency-Key`: أثر واحد.
- **المجموعات الكاملة:**
  ```bash
  cd backend && npm run typecheck && npm run typecheck:sqlite && npm run test:sqlite
  DATABASE_URL=<.env.test مع المنفذ 55432> npm test
  cd .. && npx tsc --noEmit && npx vitest run
  ```
- **المزامنة الفعلية:**
  ```bash
  node backend/scripts/verify-sync-multidevice.mjs --ac8 --device-engine sqlite --refresh-template
  ```
  يُضاف سيناريو صغير: إنشاء طرف برصيد افتتاحي بالدولار على الجهاز A، ثم تعديله على A. يجب أن يحمل المركز وB نفس السطور (ملغاة وفعّالة). البندان المعروفان في `balance_after_kg` غير متعلقين بهذه المهمة.
- **التطابق:** `node scripts/parity/run.mjs --engine sqlite --out <dir>` يجب أن يبقى ناجحاً.

---

## 3. المهمة الثانية: ترويسة الفاتورة

### 3.1 ما وُجد

- الترويسة مشتركة لكل المستندات في `src/components/print/PrintDocument.tsx` (السطور 44 إلى 56 للعقد، و110 إلى 132 للعرض):
  - الشعار يساراً، واسم الشركة (`PRINT_BRAND_NAME`) مع سطور الاتصال الخمسة يميناً في عمود واحد.
  - سطور الاتصال تأتي من `getCompanyContactLines()` في `src/shared/constants/printConfig.ts`، وتتضمن الأرقام وأسماء المالكين.
- الأنماط في `src/components/print/print.css`:
  - `.print-brand-bar` شبكة بعمودين `70px minmax(0,1fr)`.
  - `.print-brand-name` بحجم 16pt.
  - تعديلات خاصة بمقاس A5 (حوالي السطر 920) و80mm (حوالي السطر 960).
- التصميم مثبّت باختبار `src/components/print/PrintDocument.header.test.tsx`.

### 3.2 خطوات التنفيذ

1. في `PrintDocument.tsx`: فصل اسم الشركة عن كتلة الاتصال، ليصبح للترويسة ثلاثة أعمدة:
   - **يسار:** الشعار.
   - **وسط:** `PRINT_BRAND_NAME`.
   - **يمين:** سطور الاتصال الخمسة كما هي بالضبط، دون دمج أو عكس اتجاه.
   - تحديث تعليق "Header contract".
2. في `print.css`:
   - `.print-brand-bar` يصبح `grid-template-columns: 70px 1fr minmax(0, auto)`، مع اتجاه LTR للشبكة كما هو الآن.
   - اسم الشركة `text-align: center`، بخط كبير (حوالي 20 إلى 22pt) وعريض.
   - الاتصال بمحاذاة يمين، واتجاه RTL للنص.
   - تعديل كتلتي A5 و80mm. في 80mm يُرجَّح تكديس الاسم فوق الاتصال إذا ضاق العرض.
   - الصفحات التالية للأولى (`--compact`) تُظهر الاسم في الوسط دون الاتصال، كما هو الآن.
3. لا تغيير في `printPortal.ts` لهذه المهمة، ولا في توليد PDF.

### 3.3 الفحص

- تحديث `PrintDocument.header.test.tsx` ليثبّت العقد الجديد: الاسم مرة واحدة داخل عنصر الوسط، والسطور الخمسة داخل عنصر اليمين، والشعار وحده يساراً.
- `npx vitest run src/components/print` بما فيه `blankFirstPage.test.ts`.
- معاينة يدوية: فاتورة بيع على A4 وA5 و80mm، وفحص بصري لملف PDF المؤرشف.

---

## 4. المهمة الثالثة: الطباعة المباشرة على الطابعة الورقية

### 4.1 ما وُجد

- **لا يوجد في التطبيق كود اتصال بطابعة.** الطباعة تمر هكذا: `printDocument()` ثم `window.print()` داخل WebView2، ثم نافذة طباعة Windows، ثم الـ Spooler وتعريف الطابعة (`src/components/print/printPortal.ts`، الدالة `printDocument` حوالي السطور 203 إلى 256).
- **البهتان (سببه مؤكد):** `print.css` يعرّف `--mf-gray: #7a736a` و`--mf-ink: #3d3a36` و`--mf-gold: #b08d2e` و`--mf-gold-dark: #8c6e20`، ويستخدمها لعناوين وتسميات كثيرة (مثل "الأثواب" و"الأوزان"). على الطابعات الأحادية تتحول إلى رمادي فاتح.
- **اختفاء الشعار (سببه مؤكد):**
  - الشعار `src/assets/logo-motard-icon.png` حجمه 12KB، أكبر من حد التضمين الافتراضي في Vite (4KB)، فيُبنى كرابط ملف `/assets/logo-motard-icon-<hash>.png` وليس Base64. تم التحقق من ذلك في `resources/server/web/assets/logo-motard-icon-*.js`.
  - `printDocument` يستدعي `window.print()` بعد `flushSync` ومهلة 200ms فقط، **دون انتظار تحميل الصورة**، فتذهب الصفحة للطابعة أحياناً قبل أن يكتمل الشعار.
  - كذلك HTML الأرشيف (`buildArchiveHtml`) يضمّن الأنماط فقط، والصورة تبقى رابطاً نسبياً.
- **الاستقرار:** لا يوجد منع لضغط الطباعة مرتين أثناء طباعة جارية. والتنظيف يعتمد فقط على حدث `afterprint`، فإذا لم يصل (إلغاء أو خطأ في الطابعة) يبقى المستند معلقاً حتى الطباعة التالية.

### 4.2 خطوات التنفيذ

1. **التباين:** كتلة `@media print` في **نهاية** `print.css`:
   - `[data-print-root] *` يأخذ `color: #000 !important` و`-webkit-print-color-adjust: exact` و`print-color-adjust: exact`.
   - الحدود والخطوط داخل الجداول: `border-color: #000 !important`.
   - العناوين ورؤوس الجداول والتسميات (`.print-brand-name`، عناوين المستند، `th`، وفئات التسميات الرمادية): `font-weight: 700`.
   - الخلفيات الملونة الفاتحة: `background: #fff !important` حيث لا تحمل معنى.
   - هذه الكتلة لا تؤثر على الشاشة.
   - **ملاحظة:** الـ PDF المؤرشف يُبنى من نفس الأنماط عبر `--print-to-pdf`، فسيصبح أسود حاداً أيضاً، وهو المطلوب للوضوح. إذا أُريد إبقاؤه ملوناً تُحصر الكتلة بسمة على عنصر الجذر تُضاف في مسار `window.print()` فقط. قرّر قبل التنفيذ، والافتراضي أسود للاثنين.
2. **الشعار:**
   - في `PrintDocument.tsx` استبدل الاستيراد بـ `import logoUrl from "@/assets/logo-motard-icon.png?inline";`، وهي ميزة Vite وتنتج `data:image/png;base64,...`. أضف تعريف النوع إذا لزم.
   - يصبح الشعار مضمّناً في الطباعة الورقية وفي HTML الأرشيف معاً.
3. **انتظار الجاهزية** (`printPortal.ts`): قبل `window.print()` انتظر:
   - `img.decode()` (أو `load`) لكل صورة داخل الحاوية.
   - و`document.fonts.ready`.
   - بحد أقصى حوالي 3 ثوانٍ عبر `Promise.race`، فلا تتعطل الطباعة إذا تأخر شيء.
   - احذف الاعتماد على مهلة الـ 200ms الثابتة كضمان وحيد، مع إبقائها إن لزم.
4. **الاستقرار** (`printPortal.ts`):
   - علم `printing` يمنع بدء طباعة ثانية حتى تنتهي الأولى، ويظهر toast: "الطباعة جارية".
   - تنظيف احتياطي عبر `matchMedia('print')` (عند تغيّر `matches` إلى false) أو مهلة احتياطية، إذا لم يصل `afterprint`.
   - رسالة واضحة عند فشل تجهيز المستند، وهي موجودة حالياً عبر `alert`. يُستبدل بها `toast.error` إن كان آمناً، لتوحيد الأسلوب.
5. **خارج نطاق التطبيق، ويوثَّق للعميل:** انقطاع الطابعة أو تأخر الشبكة أو امتلاء الـ Spooler تُعالَج في Windows (إعدادات الطابعة، "Keep printed documents"، تحديث التعريف). لا يدّعي التطبيق معالجتها.

### 4.3 الفحص

- اختبار وحدة: `src` الشعار في `PrintDocument` يبدأ بـ `data:image/png;base64,`.
- اختبار وحدة لـ `printPortal`: `window.print` لا يُستدعى قبل اكتمال الصور (صورة وهمية تكتمل بعد تأخير)، ويُستدعى بعد المهلة القصوى إن لم تكتمل، والضغط المزدوج يطبع مرة واحدة.
- `npx vitest run src/components/print`، ثم المجموعة الكاملة للواجهة.
- **يدوياً (عند العميل أو بطابعتك):**
  1. طباعة فاتورة بيع على طابعة أحادية: كلمتا "الأثواب" و"الأوزان" بالأسود الصريح، والشعار ظاهر.
  2. إلغاء نافذة الطباعة ثم إعادة الطباعة فوراً: لا يبقى مستند معلق.
  3. ملف PDF المؤرشف ما زال سليماً.

---

## 5. ترتيب العمل الإجمالي

1. اللقطة الاحتياطية (القسم 0).
2. **المهمة الثانية (الترويسة)**، لأنها الأصغر وتمس العرض فقط، ثم اختباراتها.
3. **المهمة الثالثة (الطباعة)**، لأنها تتعلق بنفس الملفات، ثم اختباراتها.
4. **المهمة الأولى (الرصيد الافتتاحي)** بالترتيب 2.3: ترحيل، ثم مخطط، ثم حالة استخدام، ثم مستودعات، ثم مسار، ثم مزامنة، ثم واجهة، ثم اختبارات.
5. المجموعات الكاملة، ثم `verify-sync-multidevice`، ثم `parity/run.mjs`.
6. مراجعة `git diff` ومقارنته باللقطة الاحتياطية. الفروق يجب أن تقتصر على الملفات المذكورة هنا.
7. لا commit إلا بطلب صريح. وعند الطلب: commit انتقائي للملفات والسطور الخاصة بهذه المهام فقط.
8. بناء نسخة جديدة للعميل (`npm run tauri:release` في `desktop/`) فقط عند الطلب.

---

## 6. نقطة البداية في الجلسة القادمة

> **ابدأ من القسم 0 (اللقطة الاحتياطية)، ثم القسم 3.2، الخطوة 1:** فتح `src/components/print/PrintDocument.tsx` (السطور 110 إلى 132)، وفصل `print-brand-name` عن `print-brand-contact` إلى ثلاثة أعمدة، ثم `print.css` (`.print-brand-bar` حوالي السطر 156).
>
> بعد إكمال المهمتين 2 و3 واجتياز اختباراتهما، انتقل إلى **القسم 2.3، الخطوة 2** (ترحيل `opening_currency`).

**تذكير بأوامر الفحص الأساسية:**
```bash
cd backend && npm run typecheck && npm run typecheck:sqlite && npm run test:sqlite
cd .. && npx tsc --noEmit && npx vitest run
```
