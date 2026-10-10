تدقيق هندسي جنائي لنظام ME ERP — التقرير النهائي
ملاحظة منهجية عن النطاق والقيود: هذا التدقيق أُجري بأداة بحثٍ للقراءة فقط (read-only) على فرع main. لم أُنفّذ أي أمر بناء أو اختبار أو هجرة — لذا كل نتيجة تعتمد على «تشغيل فعلي» مُعلَّمة NOT RUN مع الاعتماد على ما يثبته الكود نفسه. بعض محتويات الملفات قد تكون خارج فهرس البحث بسبب حدود الحجم، وهذا مُسجَّل في سجل التغطية. README.md:109-116

أ. الحكم التنفيذي (Executive Verdict)
الحالة العامة: AMBER — قابل للاستخدام الإنتاجي المُراقَب ضمن حدود مذكورة، مع مخاطر متبقية موثّقة.

المشروع ليس مجرد نموذج يعمل في بيئة تطوير فقط؛ فهو يُظهر نضجاً هندسياً حقيقياً غير معتاد في أنظمة بهذا الحجم: فصل طبقات فعلي (Clean Architecture / ports-and-adapters)، مصدر حساب مالي واحد مشترك بين الواجهة والخادم، عزل مستأجرين بـ FORCE ROW LEVEL SECURITY ودور تشغيلي NOBYPASSRLS، دفتر قيود append-only بقيود توازن على مستوى قاعدة البيانات، وطبقة مزامنة بنمط Transactional Outbox مع كشف تعارضات قائم على الإصدار. tenant-context.ts:10-23 verify-rls.mjs:135-141

لكنّه ليس GREEN للأسباب التالية:

مسار الهجرة المزدوج (db:migrate معطوب فعلياً، وdb:push هو المسار الحقيقي) يُمثّل خطر ترقية على تثبيتات العملاء القائمة. idempotency-key.table.ts:21-29
جزء كبير من مجموعة اختبارات المزامنة اختبارات بنيوية نصية (تقرأ ملف المصدر وتبحث عن سلاسل نصّية بـ .includes/regex) لا تُنفّذ السلوك الفعلي — تنجح ولو انكسر السلوك ما دامت السلسلة موجودة. sync-invariants.test.ts:9-13
حادثة فقدان بيانات حقيقية (إعادة ضبط مصنعي بنقرة واحدة) وقعت فعلاً وأُصلحت — دليل على هشاشةٍ تشغيلية سابقة لا على استقرار مُثبت منذ البداية. PROJECT-STATUS.md:15-29
لم أتمكن من تنفيذ أي اختبار بنفسي؛ ادعاءات «110/110» و«16/16» غير مُتحقَّق منها في هذا التدقيق (NOT RUN). README.md:72-75
الأمان للعمليات المالية والمخزنية: مقبول مع تحفُّظ — الثوابت المحاسبية مفروضة في قاعدة البيانات لا في الواجهة فقط، وهذا هو الدليل الأقوى على الجاهزية.

ب. بطاقة التقييم الهندسية (Scorecard 0–5)
#	الفئة	الدرجة	الثقة	ما يمنع درجة أعلى
1	Architecture & modularity	4	High	ازدواج منطق الإبطال (invalidation) في الواجهة
2	Dependency management	3	Medium	عدم تطابق مقصود drizzle-orm/drizzle-kit؛ drizzle-kit كتبعية prod في جذر المشروع
3	Code correctness	4	Medium	مسارات as never/as any عند حدود المزامنة
4	ERP business logic	4	High	قواعد FX/تقييم المرتجع معقّدة وموثّقة لكن قليلة التغطية السلوكية
5	Database integrity	4	High	ازدواجية db:push مقابل db:migrate
6	Sync & offline reliability	3	Medium	تطبيق الوحدة على الـ hub غير ملفوف في معاملة واحدة (tombstone+delete)
7	Frontend state & API	3	Medium	قوائم invalidation مكرّرة يدوياً بدل الدالة المركزية
8	Security	4	Medium	openLoopback يمنح super-admin بلا مصادقة على loopback
9	Test quality	2	High	اعتماد واسع على اختبارات نصّية-بنيوية هشّة
10	Performance & scale	NOT ASSESSED	—	لا توجد قياسات حمل؛ لم أُنفّذ شيئاً
11	Build & deployment	3	Medium	مسار الهجرة المزدوج + عدم تنفيذ البناء هنا
12	Backup & recovery	4	Medium	توجد استعادة ذرّية مُختبَرة؛ لم أتحقّق تشغيلياً
13	Observability	4	Medium	Sentry + pino + boot_log + safe-mode؛ جيّد
14	Documentation	4	High	PROJECT-STATUS.md وdecisions.md صريحة ونزيهة
15	Long-term change safety	3	Medium	حاجز الانحدار الحقيقي ضعيف بسبب جودة الاختبارات
الدرجات تقدير منظّم لا ضمان احتمالي للفشل.

ج. سجل النتائج (Findings Register)
[F-01] [P1] — مسار هجرة مزدوج: db:migrate معطوب وdb:push هو مسار الإنتاج الفعلي
Category: Database / Upgrades · Confidence: High · Status: Confirmed (بدليل الكود) / تأثير الترقية High-confidence risk
Location: backend/src/infrastructure/orm/schemas/idempotency-key.table.ts:21-29
Evidence: تعليق موثّق داخل الكود: «db:migrate يفشل على صياغة CREATE POLICY IF NOT EXISTS غير الصالحة في 0001 … db:push هو المسار الوحيد الذي يعمل فعلاً»، وهذا أدى سابقاً إلى عدم إنشاء جدول idempotency_keys إطلاقاً والسقوط الصامت إلى Map في الذاكرة. idempotency-key.table.ts:21-29
Why risky: db:push يوائم المخطط بالفرق لا بالترتيب؛ وجود مسارين (push في البيئة، ومُشغّل هجرات drizzle في الديسكتوب runDesktopMigrations) يخلق احتمال انحراف مخطط (schema drift) بين تثبيت نظيف وترقية فوق بيانات قائمة. server.ts:519-524
Blast radius: كل ترقية عميل لديه بيانات.
Recommended: توحيد مصدر الحقيقة للمخطط على مُشغّل الهجرات، وإصلاح 0001، وإضافة اختبار تطابق بين ناتج push وناتج تطبيق الهجرات بالترتيب (يوجد schema-migration-parity.test.ts — يجب التأكد أنه يغطّي هذا).
Verification test: تطبيق كل الهجرات بالترتيب على قاعدة فارغة ثم مقارنة الكتالوج بناتج db:push.

[F-02] [P1] — جزء كبير من اختبارات المزامنة اختبارات نصّية-بنيوية لا سلوكية
Category: Test quality · Confidence: High · Status: Confirmed
Location: backend/tests/sync-invariants.test.ts (كامل)، وأمثلة invalidateFinancialViews.test.ts:66-79
Evidence: الاختبارات تقرأ نص الملف المصدري وتؤكّد وجود سلاسل مثل expect(src.includes("withTenantTx")).toBe(true) و/baseVersion !== null .../.test(fn). sync-invariants.test.ts:315-323 invalidateFinancialViews.test.ts:66-73
Why risky: هذا النوع ينجح حتى لو كان السلوك الفعلي خاطئاً، ويفشل عند إعادة صياغة غير ضارّة — أي يعطي ثقة زائفة ويعيق إعادة الهيكلة. إنها «أقفال تراجع» ضد عودة نمطٍ سيّئ، لا تحقّقٌ من الصحّة.
Mitigation موجود: هناك اختبارات تكامل حقيقية على PostgreSQL فعلي (مثل cross-currency-settlement.test.ts, ledger-entry-types.test.ts) وحزمة متعدّدة الأجهزة scripts/verify-sync-multidevice.mjs. cross-currency-settlement.test.ts:318-345 verify-sync-multidevice.mjs:1049-1080
Recommended: تحويل الثوابت الحرجة (stale-base، idempotency، lease) إلى اختبارات سلوكية على قاعدة حقيقية بدل مطابقة النص.

[F-03] [P2] — تطبيق وحدة المزامنة على الـ hub ليس ذرّياً (delete + tombstone)
Category: Sync / Atomicity · Confidence: High · Status: Confirmed (مُقرٌّ به في الكود)
Location: backend/src/application/use-cases/sync/syncMaterialize.ts:1326-1345
Evidence: تعليق صريح: «رغم غياب معاملة واحدة ملفّة، إن فشلت كتابة الـ tombstone نُعيد failed فتُعاد المحاولة». الحذف والـ tombstone متتاليان لا ذرّيان، والاعتماد على idempotency المسار !hub. syncMaterialize.ts:1326-1345
Why risky: نافذة فشل بين الحذف وكتابة الـ tombstone قد تُبقي صفاً محذوفاً بلا شاهد قبر، فيُحيي إعادة الإنشاء المتأخّرة السجل. يُخفَّف بإعادة المحاولة لكن ليس مضموناً ذرّياً.
Recommended: لفّ delete+tombstone في withTenantTx واحدة.

[F-04] [P2] — openLoopback يمنح صلاحيات super-admin دون مصادقة على الاتصال المحلي
Category: Security / AuthZ · Confidence: Medium · Status: High-confidence risk
Location: backend/src/infrastructure/http/middleware/super-admin-auth.middleware.ts:32-41
Evidence: عند تفعيل openLoopback، أي طالب من 127.0.0.1/::1 يُمنح role: "super_admin" بلا رمز. super-admin-auth.middleware.ts:32-41
Why risky: على جهاز متعدّد المستخدمين أو مع SSRF/وكيل محلي، قد يصل مستخدم غير مُخوَّل إلى وحدة تحكّم الترخيص. مقبول كخيار «وحدة تحكّم المالك المحلية» لكنه خطر إن فُعِّل في بيئة مشتركة.
Recommended: توثيق أنه حصراً للـ owner console، وتعطيله افتراضياً، وربطه ببصمة الجهاز.

[F-05] [P2] — ازدواج قوائم إبطال كاش الواجهة بدل الدالة المركزية
Category: Frontend state consistency · Confidence: High · Status: Confirmed
Location: src/presentation/hooks/useInvoices.ts:113-128, useExpenses.ts:73-78, useReturns.ts:57-66 مقابل الدالة المركزية invalidateFinancialViews.ts
Evidence: توجد دالة مركزية invalidateFinancialViews تُبطل كل العائلات المالية، لكن useInvoices/useExpenses/useReturns تكتب قوائم invalidateQueries يدوية مختلفة (بعضها يُبطل statement وبعضها لا). invalidateFinancialViews.ts:10-24 useExpenses.ts:73-78
Why risky: عند إضافة عائلة كاش مالية جديدة، سيُحدَّث بعض المسارات دون بعض، فتظهر بيانات قديمة في شاشة دون أخرى (مشكلة عرض، لا تلف بيانات).
Recommended: توجيه كل مسارات الطفرة المالية عبر invalidateFinancialViews.

[F-06] [P3] — رسائل نجاح/خطأ متناقضة في الواجهة
Category: UX correctness · Confidence: High · Status: Confirmed
Location: src/presentation/hooks/useReturns.ts:84, useExpenses.ts:91, useInvoices.ts:159
Evidence: الإلغاء الناجح يُعرَض بـ toast.error("تم إلغاء المرتجع") — نجاحٌ يُعرض كخطأ (لون/أيقونة خطأ). useReturns.ts:83-84
Impact: إرباك المستخدم فقط؛ لا أثر على البيانات.

[F-07] [P3] — drizzle-kit تبعية إنتاج في package.json الجذر
Category: Dependencies · Confidence: High · Status: Confirmed
Location: package.json:85
Evidence: drizzle-kit مُدرجة ضمن dependencies لا devDependencies في جذر الواجهة. package.json:85
Impact: انتفاخ حزمة الواجهة وسطح هجوم أكبر؛ أداة هجرة لا لزوم لها في runtime الواجهة.

[F-08] [P4] — ازدواج مقصود لدالة uuidFromString بين وحدتي مزامنة
Category: Maintainability · Confidence: High · Status: Confirmed (ACCEPTABLE WITH TRADE-OFF)
Evidence: تعليق: «مكرّرة في syncUseCases.ts — أُبقيت جنباً إلى جنب (لا تُستورد) لأن هذه الوحدة ورقة شجرة تبعيات سطح المزامنة». syncEnqueue.ts:42-51 مقايضة واعية، لكن تغيير أحدهما دون الآخر يُفسد تطابق المفاتيح عبر الأجهزة.

د. خرائط البنية (Architecture Maps)
تشغيل الديسكتوب (CURRENT)
desktop/src-tauri (Rust) runtime/stack.rs

postgres.exe (منفذ ديناميكي)

node backend/dist (DESKTOP_DEPLOY=true)

runDesktopMigrations()

verifyDataAgainstManifest / TENANT_MISMATCH → safe-mode

app.listen → يكتب DESKTOP_PORT_FILE بعد الجاهزية

/api/health/live ثم __health ثم إظهار النافذة

stack.rs:15-25 server.ts:587-618

تدفّق عملية عمل → كتابة قاعدة (مثال فاتورة بيع)
invoice.route.ts (auth→license→write guards→idempotency required)

withTenantTx(tenantId)

insert invoices + invoice_lines (قفل الصبغات مرتّب)

ledger_entries (Dr party / Cr revenue / COGS / inventory)

sync_outbox (نفس المعاملة — Transactional Outbox F-07)

append-only trigger + CHECK: Σdebit=Σcredit

PostgresInvoiceRepository.ts:1152-1196 sync-invariants.test.ts:315-323

حدود مؤكّدة: كتابة GUC والوصول لـ pg محصوران في drizzle.ts (مفروض باختبار). rls-guard.test.ts:128-152
اقتران خفي/مشبوه: مسار تطبيق المزامنة غير الذرّي (F-03)؛ قوائم invalidation المكرّرة (F-05).

هـ. تغطية الملفات (Coverage Register)
المجال	المسؤولية	العمق	ملاحظات
backend/src/infrastructure/repositories	المستودعات (invoice/voucher/return/party/cashbox/ledger)	Deep	محور المنطق المالي
backend/src/application/use-cases/sync	محرّك المزامنة (enqueue/materialize)	Deep	أعلى مخاطر التغيير
backend/src/infrastructure/orm (schemas/migrations/rls/drizzle)	المخطط وRLS والهجرات	Deep/Partial	0002_snapshot.json ضخم — فحص جزئي
backend/tests + scripts/verify-*	الاختبارات	Deep (قراءة) / NOT RUN (تنفيذ)	انظر F-02
src/ (الواجهة)	hooks/api/http	Partial	عيّنات تمثيلية
desktop/src-tauri	إقلاع Rust	Partial	stack.rs فحص جزئي
admin-dashboard/, packages/shared/	لوحة الترخيص / المشترك	Not inspected / Partial	لم يُفحص admin-dashboard
ملفات لا تُعدَّل باستهتار (أعلى blast radius): backend/src/infrastructure/orm/drizzle.ts (مُحتكِر GUC/pool)، packages/shared (سلطة الحساب المالي الوحيدة)، syncMaterialize.ts، rls/enable-rls.sql.

و. تقرير كفاية الاختبارات (مختصر)
قوي سلوكياً: توازن قيود الدفتر، تسوية متعدّدة العملات (FX)، append-only trigger، keyset pagination، الاستعادة الذرّية. ledger-entry-types.test.ts:68-84
ضعيف/نصّي: معظم sync-invariants.test.ts وبعض اختبارات hooks الواجهة (مطابقة نص). sync-invariants.test.ts:749-758
فجوات ذات أولوية: (1) اختبار سلوكي لذرّية delete+tombstone على الـ hub؛ (2) اختبار انحراف المخطط push ↔ migrate؛ (3) اختبار تزامن حقيقي لإنشاء فاتورتين على نفس الصبغة؛ (4) اختبار سلوكي لـ openLoopback.
ز. أخطر النتائج المؤكّدة والأولويات
أخطر نتيجة مؤكّدة: ازدواجية مسار الهجرة (F-01) لأنها تمسّ كل ترقية عميل لديه بيانات مالية.
ما يجب إصلاحه أولاً: F-01 ثم F-02 (لأن ضعف الاختبارات يخفي انحدارات المسائل المالية).
ما يجب ألّا يُعاد هيكلته قبل تغطية اختبارية سلوكية: syncMaterialize.ts, PostgresVoucherRepository/PostgresInvoiceRepository (منطق FX والدفتر)، وdrizzle.ts.
الدليل الناقص قبل اعتباره production-ready: تنفيذ فعلي لمجموعة الاختبارات وتقرير تغطية فروع (branch coverage)، وقياس أداء على مجموعة بيانات تمثيلية متعدّدة السنوات (Phase 11 = NOT ASSESSED).
ح. إجابات مباشرة (مختصرة)
هندسة سليمة؟ نعم إجمالاً (فصل طبقات حقيقي + مصدر حساب واحد). 2. بنية المجلدات مناسبة؟ نعم. 3. حدود الوحدات حقيقية أم شكلية؟ حقيقية ومفروضة باختبارات بنيوية (مثل حصر pg/GUC في drizzle.ts). 4. التبعيات صحّية؟ غالباً، مع F-07. 5. المكتبات الخارجية مُستخدمة جيداً؟ نعم. 6. المرافق المشتركة موثوقة؟ نعم (@erp/shared سلطة واحدة للحساب). 7. ازدواج/تناقض في منطق العمل؟ محدود (F-05, F-08). 8. عيوب صحّة حرجة؟ لا عيب مالي مؤكّد؛ المخاطر في الترقية والذرّية. 9. عيوب أصغر؟ نعم (F-06, F-07). 10. هل تغيير صغير قد يكسر شيئاً بعيداً؟ نعم في المزامنة والواجهة بسبب ضعف الاختبارات السلوكية. 11. دليل الهشاشة؟ F-02 (حاجز انحدار نصّي) + حادثة فقدان البيانات الموثّقة. 12. هل تحمي الاختبارات أهم القواعد؟ جزئياً (قاعدة البيانات نعم، المزامنة نصّياً). 13. اعتماد مفرط على mocks؟ لا؛ الأسوأ هو مطابقة النص لا الـ mocks. 14. قاعدة البيانات آمنة تحت الفشل/التزامن؟ نعم غالباً (معاملات + FOR UPDATE SKIP LOCKED + قيود توازن). 15. المزامنة آمنة تحت الانقطاع/الإعادة؟ غالباً نعم (outbox + lease + idempotency + stale-base)، مع تحفّظ F-03. 16. تطوّر المخطط بأمان؟ مخاطر (F-01). 17. التخويل في الحدّ الصحيح؟ نعم (RLS في قاعدة البيانات)، مع تحفّظ F-04. 18. قابل للتشخيص؟ نعم (Sentry/pino/boot_log/safe-mode). 19. الإقلاع/الحزم/الترقية/النسخ مُختبَرة؟ موثّقة وادُّعي تشغيلها، لكن NOT RUN هنا. 20. صيانة عشر سنوات؟ مُحتملة إن عولجت جودة الاختبارات ومسار الهجرة. 21. أخطر نتيجة = F-01. 22. أول ما يُصلَح = F-01 ثم F-02. 23. لا يُعاد هيكلته قبل التغطية = محرّك المزامنة والمستودعات المالية. 24. الدليل الناقص = تنفيذ فعلي للاختبارات + قياس أداء على حجم واقعي.
ملاحظة ختامية
لم تُعدَّل أي ملفات أو قواعد بيانات، ولم تُكشف أي أسرار، ولم يُدَّعَ أي «ضمان عشر سنوات». الفصل بين «المُثبَت بالكود» و«المُدَّعى في الوثائق» و«غير المُتحقَّق منه (NOT RUN)» حُفظ طوال التقرير. لتحويل الحالة من AMBER إلى GREEN يلزم: إصلاح مسار الهجرة الموحّد، وتحويل الثوابت المالية/المزامنة الحرجة إلى اختبارات سلوكية على قاعدة حقيقية، وتشغيل فعلي موثّق لمجموعة الاختبارات مع تقرير تغطية فروع.

