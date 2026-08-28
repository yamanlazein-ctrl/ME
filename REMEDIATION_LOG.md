# REMEDIATION_LOG.md — سجل الإصلاحات المرجعي

> **لأي جلسة AI أو مطوّر لاحق:** هذا الملف هو المرجع الرسمي للأخلال التي **شُخِّصت وأُصلحت وأُثبتت حيّاً**.
> **قبل أن تفتح أي بند هنا من جديد،** اقرأ الإصلاح ودليله. إن أردت تغييره، افعل ذلك بوعي —
> لا "تكتشفه" مرة أخرى كمشكلة جديدة.
>
> ملفات مكمّلة: `docs/TASK-open-items.md` (بنود **مفتوحة** لم تُحلّ) · `docs/decisions.md` (قرارات تصميم).

---

## R-01 — حجب CORS يمنع لوحة التراخيص (5174) من مكالمة خادم التراخيص (8081)

- **التاريخ:** 2026-08-28
- **الخطورة:** حاجزة (اللوحة غير قابلة للاستخدام من المتصفح) · **تصنيف:** أمني/إعدادات
- **الحالة:** ✅ **مُصلَح ومُثبَت حيّاً**

### المشكلة

لوحة إصدار التراخيص (`admin-dashboard/`) تعمل على `http://localhost:5174`، وكانت تنادي خادم
التراخيص برابط **مطلق** `http://localhost:8081`. قائمة سماح CORS في الخلفية كانت
`http://localhost:5173` فقط (واجهة الـERP)، فحجب المتصفح الطلب **قبل** وصوله للخادم.

**الأثر الفعلي:** صاحب المشروع **لا يستطيع تسجيل الدخول للوحة ولا إصدار أي مفتاح ترخيص** من
المتصفح. المحرّك الخلفي كان سليماً تماماً — العطب في طبقة الواجهة فقط، وهذا ما جعله مضلّلاً.

**الدليل قبل الإصلاح** (متصفح حقيقي — Playwright على `localhost:5174`):
```
[console] Access to fetch at 'http://localhost:8081/license-admin/login' from origin
          'http://localhost:5174' has been blocked by CORS policy: Response to preflight
          request doesn't pass access control check
[req]     http://localhost:8081/license-admin/login :: net::ERR_FAILED
```
وفي المقابل، نفس النقطة من طرف الخادم (بلا متصفح) كانت تعيد `200` + توكن — إثبات قاطع أن
الخادم سليم وأن الحجب من CORS في المتصفح.

### السبب الجذري

| الموضع | ما كان |
|---|---|
| `admin-dashboard/src/lib/api.ts:3` | `const API_BASE = import.meta.env.VITE_LICENSE_SERVER_URL \|\| "http://localhost:8081"` → رابط مطلق ⇒ cross-origin |
| `backend/src/infrastructure/config/env.ts` | `CORS_ORIGIN: z.string().default("http://localhost:5173")` → قيمة **واحدة**، لا قائمة |
| `backend/.env` | `CORS_ORIGIN=http://localhost:5173` → ناقص `5174` |
| `admin-dashboard/vite.config.ts:15-24` | **proxy جاهز** لـ`/license-admin` و`/v1` → 8081، لكنه **غير مستخدم** لأن `api.ts` يستعمل رابطاً مطلقاً |

القرار السابق كان ينوي المرور عبر الـproxy (لذلك أُعدّ) ولم يُكمَل.

### الحل المطبَّق (طبقتان)

**الطبقة 1 — الجذر: مسارات نسبية عبر الـproxy** (`admin-dashboard/src/lib/api.ts`)
```ts
// قبل
const API_BASE = import.meta.env.VITE_LICENSE_SERVER_URL || "http://localhost:8081";
// بعد
const API_BASE = (import.meta.env.VITE_LICENSE_SERVER_URL ?? "").replace(/\/+$/, "");
```
أساس فارغ ⇒ كل النداءات نسبية ⇒ يمرّرها Vite proxy ⇒ **same-origin ⇒ CORS لا يدخل المعادلة أصلاً.**

**الطبقة 2 — دفاع إضافي: قائمة سماح CORS مفصولة بفواصل**
- `backend/src/infrastructure/config/env.ts` — الافتراضي صار
  `"http://localhost:5173,http://localhost:5174"` + تصدير `corsOrigins` التي تفصل النص إلى مصفوفة
  (و`"*"` يمرّ كما هو، وما زال مرفوضاً في الإنتاج).
- `backend/src/presentation/server.ts` و`backend/src/scripts/license-server.ts` — كلاهما
  `cors({ origin: corsOrigins })` بدل النص المفرد.
- `backend/.env` (محلي) و`backend/.env.example` — `CORS_ORIGIN=http://localhost:5173,http://localhost:5174`.

الغاية: أي نداء **يتجاوز** الـproxy (سكربت، اختبار يدوي، لوحة مستضافة على أصل آخر) لا ينكسر بصمت.

### ⚠️ تحذير الإنتاج (أساسي — لا تُسقطه)

حل الـproxy يعمل **في وضع التطوير فقط** (`vite dev`). البُندل الساكن المبني ليس فيه خادم يُوجّه
شيئاً. عند النشر يجب **إحدى** الاثنتين:
1. **reverse proxy حقيقي** (nginx/Caddy) أمام اللوحة يوجّه `/license-admin` و`/v1` إلى خادم
   التراخيص — يبقي كل شيء same-origin. **(المفضّل)**
2. تعيين `VITE_LICENSE_SERVER_URL` لعنوان خادم التراخيص المطلق — وحينها **يجب** إدراج أصل
   اللوحة في `CORS_ORIGIN`، وإلا يعود الحجب على السيرفر الحقيقي.

هذا التحذير مكتوب أيضاً كتعليق داخل `admin-dashboard/src/lib/api.ts` فوق `API_BASE`.

### الدليل بعد الإصلاح (كله حيّ)

**1) اللوحة من متصفح حقيقي — المسار الكامل من طرف المستخدم:**
```
تسجيل الدخول (owner@motard.local): حقل كلمة المرور اختفى (0) | زر "إصدار ترخيص جديد" ظهر
إدخال بيانات زبون: مؤسسة الفتح للأقمشة | +963 933 111 222 | ملاحظة
ضغط زر "إصدار الترخيص": صفوف الجدول 3 → 4 | إشعار "تم إصدار الترخيص بنجاح"
console errors = 0 | failed/4xx = 0
```
**2) تأكيد قاعدة البيانات** — `LIC-C591CE9B0EB0925073D93EF8`:
`customer_name` / `customer_phone` / `customer_notes` **مطابقة حرفياً للمُدخل** (`true/true/true`).

**3) المفتاح يفعّل الـERP فعلياً** (وليس نظاماً منفصلاً):
```
POST /api/license/activate -> 200
features: [inventory, accounting, sales, purchasing, reports]
AFTER: status=active | bound_to_ERP_tenant=true | activation: UI-KEY-HOST (live=true)
protected route /api/customers -> 200
```
**4) قائمة السماح تعمل بدقة** (نداء مباشر يتجاوز الـproxy):
```
Origin http://localhost:5174 -> Access-Control-Allow-Origin: http://localhost:5174   ✅
Origin http://localhost:5173 -> Access-Control-Allow-Origin: http://localhost:5173   ✅
Origin http://evil.example   -> (لا ترويسة سماح) ⇒ المتصفح يرفض                      ✅
```
**5) Regression:** typecheck خلفية نظيف · `tsc -b` للوحة نظيف · 117 اختبار وحدة · حارس الترخيص 8/8.

### بنية النظام المؤكَّدة أثناء التشخيص (مرجع مهم)

**قاعدة بيانات واحدة مشتركة `erp`، لا نظامان منفصلان:**
- `backend/src/scripts/license-server.ts` يستورد نفس `db` من
  `backend/src/infrastructure/orm/drizzle.ts` (والذي يقرأ `config.DATABASE_URL`).
- المسار: لوحة (5174) → خادم التراخيص (8081) → يكتب في `erp.licenses` → خادم الـERP (8080)
  يقرأ نفس الجدول عند التفعيل.

### الملفات المعدَّلة

| الملف | التغيير |
|---|---|
| `admin-dashboard/src/lib/api.ts` | مسارات نسبية + تعليق تحذير الإنتاج |
| `backend/src/infrastructure/config/env.ts` | `CORS_ORIGIN` قائمة + تصدير `corsOrigins` |
| `backend/src/presentation/server.ts` | `origin: corsOrigins` |
| `backend/src/scripts/license-server.ts` | `origin: corsOrigins` |
| `backend/.env.example` | توثيق صيغة القائمة |
| `backend/.env` | القيمة الفعلية (محلي، مُتجاهَل git) |

### تحقق مكمّل — لا بقايا روابط مطلقة

فحصت `admin-dashboard/src` بالكامل: **كل** نداء يمرّ عبر `API_BASE` (3 نداءات: `apiFetch`،
`login`، `fetchAuditLogs`). لا `WebSocket`، لا `ws://`، ولا أي `fetch("http…")` مباشر.

**ملاحظة منفصلة (ليست من هذا الإصلاح):** ملفات `tests/e2e/playwright.*.config.ts` وبعض
specs تستخدم `http://localhost:8081` كـ`baseURL` — لكن ذلك **تضارب تسمية تاريخي**: تقصد خادم
**واجهة قديم**، لا خادم التراخيص. تلك الملفات لا تنادي اللوحة ولا تتأثر بهذا الإصلاح. **لم أعدّلها**
(خارج النطاق) — لكن كن حذراً: منفذ `8081` مُستخدَم بمعنيين مختلفين في هذا المستودع.
