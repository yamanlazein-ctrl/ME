# 🧪 Fabric ERP — Testing Arsenal (Production Readiness)

ملخّص سريع للأوامر والأدوات المعتمدة لتسليم المشروع.

## جدول الأوامر

| الأمر | الأداة | ماذا يفعل |
| --- | --- | --- |
| `npm run test:logic` | Vitest | اختبار وحدة المنطق والحسابات (المصدر يبدأ بـ `src`) |
| `npm run test:ui` | Playwright | اختبارات E2E للواجهة (بعد تشغيل الخلفية على 8080) |
| `npm run test:e2e` | Playwright | نفس suite الشاملة (اسم قديم) |
| `npm run test:api` | Node | اختبار API شامل (`tests/e2e/comprehensive-api.mjs`) |
| `npm run test:financial` | Node | قفل القيد المزدوج المالي |
| `npm run clean:code` | Knip | يبحث عن الملفات/الاستيرادات/الخبرات غير المستخدمة |
| `npm run test:security` | Semgrep | فحص أمني ثابت على الكود |
| `npm run check:all` | — | typecheck + logic + knip دفعة واحدة |

## الإعداد / التنصيب

```bash
npm install              # يثبّت كل الأدوات (vitest, playwright, knip ...)
npx playwright install   # مرة واحدة: يُنزّل متصفحات Playwright (Chromium/Edge)
```

### Semgrep (ملاحظة مهمة)
Semgrep **ليس حزمة npm رسمية** — إنه أداة CLI بالبايثون. ثبّته بأي من:

```bash
pip install semgrep              # الموصى به
# أو
brew install semgrep             # macOS
# أو عبر Docker
docker run --rm -v "$PWD:/src" returntocorp/semgrep scan --config p/auto /src
```

## قراءة التقارير

- **Vitest:** يعرض عدد الـ tests الناجحة/الفاشلة + ملف/سطر كل فشل (أخضر/أحمر). أوامر: `vitest` (وضع المراقبة)، `npm run test:logic -- --coverage`.
- **Playwright:** بعد التشغيل:
  - `playwright-report/` → تقرير HTML تفاعلي بروابط لكل خطوة ولقطات الشاشة.
  - `test-results/` → مخرجات حالات الفشل.
  - `--reporter=line` للحصول على سطر واحد لكل test.
- **Knip:** يسرد الاستيرادات/الملفات غير المستخدمة (ويتيح `knip --fix`). الخروج غير الصفري = توجد عناصر يجب تنظيفها.
- **Semgrep:** كل قاعدة تعرض الملف/السطر/السياق. `--json` لإخراج آلي، `severity: WARNING` لترتيب الأهمية.

## كيف تطلب من المطوّر/الـ agent تنفيذ اختبار معيّن؟
قل له (مثال):
- «شغّل اختبار الوحدات المالية» → سينفّذ `npm run test:logic` أو `vitest run src/...`.
- «كبّس واجهة تسجيل فاتورة الدخول» → سيشغّل `npm run test:ui` لملف معيّن أو suite محدّد.
- «ركّز على ملف X اللوني/الدقة» → يصطاد `vitest run src/shared/utils/__tests__/...`.
- «نظّف الكود من المهملات» → `npm run clean:code` (knip).
- «اعملي فحص أمني سريع» → `npm run test:security` (semgrep).

## المتطلبات قبل E2E
سويتا E2E تفترض خلفية شغّالة على `http://localhost:8080` وقاعدة بيانات مُصفّرة
(أُخلي كل الجداول قبل التشغيل). عادةً:
```bash
cd backend && npm run dev     # تشغيل الخلفية
npm run test:ui               # ثم في جذر المشروع
```