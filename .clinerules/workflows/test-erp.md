# اختبار ERP شامل — Workflow (مُهيَّأ لمشروع Fabric ERP الحقيقي)

# موجّه لنظام Node/TypeScript (Express + React) — وليس pytest.

## الخطوة 0: تجهيز البيئة

- npm install (يثبّت vitest / playwright / knip)
- npx playwright install
- semgrep: pip install semgrep (أو brew) — للفحص الأمني

## الخطوة 1: الوحدات والمنطق (Vitest)

npm run test:logic

# مركّز:

npx vitest run src/shared/utils/**tests**/color.test.ts src/shared/utils/**tests**/precision.test.ts

## الخطوة 2: فحص الأنواع (TypeScript)

npm run typecheck

## الخطوة 3: فحص الـ API والعملية المالية

npm run test:api
npm run test:financial # قفل القيد المزدوج

## الخطوة 4: E2E — Playwright (واجهة المستخدم)

# المتطلب: cd backend && npm run dev (الخلفية على 8080 + قاعدة مُصفَّرة)

npm run test:ui

## الخطوة 5: الفحص الأمني (Semgrep)

npm run test:security

## الخطوة 6: المهملات (Knip)

npm run clean:code

# ملاحظة: يبالغ حالياً حتى نضبط entry/project لمشروع TanStack Start.

## الخطوة 7: إمكانية الوصول

# لا توجد أداة axe مركّبة؛ عند الطلب نضيف @axe-core/playwright.

## الخطوة 8: البوابة الموحدة والتقرير

npm run check:all

# الخلاصة: vitest + typecheck = البوابة الحقيقية. knip وحده قد يفشل إعدادياً (positive/false).

## الخطوة 9: إخراج التقارير تلقائياً

# تقرير HTML لـ Vitest (يتطلب @vitest/ui — مثبّت):

npm run report:vitest

# فتح تقرير Playwright HTML (بعد تشغيل test:ui):

npm run report:ui

# أو الاثنان:

npm run report:all

## تقارير الإتاحة (Axe)

# بعد تشغيل الخلفية، شغّل:

npx playwright test tests/e2e/accessibility.spec.ts --config=tests/e2e/playwright.comprehensive.config.ts

# الفشل عند وجود مخالفات critical/serious (تظهر في test-results/report).
