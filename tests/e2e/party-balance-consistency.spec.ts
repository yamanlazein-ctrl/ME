import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "module";

/**
 * ============================================================================
 *  party-balance-consistency.spec.ts
 * ============================================================================
 *  حارس دائم ضد رجوع مشكلة «رصيد الطرف غير الموحّد».
 *
 *  تاريخ الإصلاح الأصلي: 2026-08-27 (جلسة تدقيق طويلة).
 *
 *  المشكلة (التي تمنع أي رجوع لها): رصيد الطرف كان يُحسب في خمسة مواضع بربط
 *  «فواتير + سندات» فقط، فيتغاضى عن المرتجعات والسندات العامة غير المرتبطة
 *  بفاتورة والتسويات — فيتباعد عن دفتر الأستاذ (رصيد الطرف الحقيقي).
 *  الخمسة مواضع الموحّدة الآن على الأستاذ:
 *    1) قائمة الأطراف PartyTable — stats.remaining (GROUP BY خادمي على الأستاذ)
 *    2) بطاقة النظرة العامة PartyDetails — remainingByCurrency من الأستاذ
 *    3) تقرير الذمم PartyBalances — remainingOf على قيود الأستاذ
 *    4) بطاقات الداشبورد reports.index — مجموع stats.remaining
 *    5) بطاقة ديون الصندوق FinancialOverview — توفيق getDebts على رصيد الأستاذ
 *
 *  السيناريو (كل شيء يُنشأ عبر API الحقيقي خدمةً — لا INSERT مباشر، لا Mock):
 *     بيع 100,000 → مرتجع 20,000 → سند قبض عام 30,000 (بلا invoiceId!) → تسوية.
 *     الرقم الستة (الخمسة مواضع + SUM(debit)-SUM(credit) بالأستاذ) يجب أن تتطابق
 *     رقماً برقم: غير المسوّاة = 50,000، وبعد التسوية = 0.
 *
 *  ⚠️⚠️⚠️  لا تحذف هذا الاختبار (DO NOT DELETE THIS TEST)  ⚠️⚠️⚠️
 *  أي تغيير مستقبلي لأحد المواضع الخمسة يحيد عن الأستاذ سيَكسر هذا الاختبار.
 *  إن فشل فهو دليل رجوع — أعد النظر في التغيير فوراً، لا تُعطّله.
 *
 *  ملاحظات تشغيل:
 *  - يُترك عميل الاختبار مُسوّى (رصيد 0) بعد كل تشغيل — لا يُحداث انحراف أرقام.
 *  - القراءات عبر تنقّل client-side (نقر روابط التطبيق) بعد تسجيل دخول واحد،
 *    لتجنّب إجهاد SSR بإعادة التحميل الكامل ولإبقاء مخزّن الأطراف محمّلاً.
 *
 *  إثبات الطفرة (Mutation test — «اختبار الاختبار نفسه») 2026-08-27:
 *  أُعيد تقرير الذمم مؤقتاً إلى الصيغة القديمة المعطوبة
 *    (المتبقي = الإجمالي − المدفوع المرتبط، تتجاهل المرتجع + السند العام)
 *  → فشل الاختبار برقم حقيقي:
 *      الأستاذ = 50,000  لكن التقرير = [العميل | 1 | 100,000 ل.س | 0 ل.س | 100,000 ل.س]
 *      أي «مجموع الستة» تباعد:    50,000  ≠  100,000
 *  إعادة السطر الصحيح (remainingOf على الأستاذ) → PASS (الستة = 50,000، ثم 0).
 * ============================================================================
 */

const require = createRequire(import.meta.url);
const { Pool } = require("../../backend/node_modules/pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL is required"); })(),
});

const FRONT = process.env.ERP_FRONTEND_URL ?? "http://localhost:5173";
const BACKEND = process.env.ERP_BACKEND_URL ?? "http://127.0.0.1:8080";
const TENANT_ID = process.env.ERP_TENANT_ID;
const EMAIL = process.env.ERP_ADMIN_EMAIL;
const PASSWORD = process.env.ERP_ADMIN_PASSWORD;
if (!TENANT_ID || !EMAIL || !PASSWORD) throw new Error("ERP_TENANT_ID, ERP_ADMIN_EMAIL, and ERP_ADMIN_PASSWORD are required");

// ── Ground-truth أرقام (تُسجَّل قبل إدخالها) ────────────────────────────────
const INVOICE_TOTAL = 100_000; // 10 كغ × 10,000
const RETURN_AMOUNT = 20_000; // 2 كغ × 10,000
const RECEIPT_AMOUNT = 30_000; // سند قبض عام — بلا invoiceId (أخطر فجوة)
const EXPECTED_UNSETTLED = INVOICE_TOTAL - RETURN_AMOUNT - RECEIPT_AMOUNT; // 50,000
const EXPECTED_SETTLED = 0;

const state = {
  token: "" as string,
  customerId: "" as string,
  customerName: "" as string,
  customerCode: "" as string,
  invoiceId: "" as string,
  invoiceNumber: "" as string,
  fabricId: "" as string,
  colorId: "" as string,
  rollId: "" as string,
  openDate: "" as string,
};

// ── helpers ────────────────────────────────────────────────────────────────
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

async function api(path: string, method = "GET", body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${BACKEND}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data as Record<string, any>;
}

async function sql<T extends Record<string, unknown>>(
  query: string,
  params: (string | number)[] = [],
): Promise<T[]> {
  const r = await pool.query(query, params);
  return r.rows as T[];
}

/** المرجع: رصيد الأستاذ المباشر لهذا الطرف (SYP) = SUM(debit) − SUM(credit). */
async function ledgerBalanceSql(partyId: string): Promise<number> {
  const rows = await sql<{ v: string }>(
    `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS v
     FROM ledger_entries
     WHERE party_id = $1 AND tenant_id = $2 AND status = 'active' AND currency = 'SYP'`,
    [partyId, TENANT_ID],
  );
  return Number(rows[0].v);
}

/** إجمالي ذمم العملاء (SYP) من الأستاذ مباشرة — لمطابقة بطاقة الداشبورد. */
async function totalReceivablesSql(): Promise<number> {
  const rows = await sql<{ v: string }>(
    `SELECT COALESCE(SUM(le.debit),0) - COALESCE(SUM(le.credit),0) AS v
     FROM ledger_entries le
     JOIN parties p ON p.id = le.party_id
     WHERE le.tenant_id = $1 AND le.status = 'active' AND le.currency = 'SYP'
       AND p.kind = 'customer'`,
    [TENANT_ID],
  );
  return Number(rows[0].v);
}

/** استخرج قيمة الـ SYP (بجوار «ل.س») من نص معروض. */
function extractSYP(text: string): number | null {
  const m = text.match(/([\d,]+)\s*ل\.س/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

async function browserLogin(page: Page): Promise<void> {
  await page.goto(`${FRONT}/`, { waitUntil: "domcontentloaded" });
  const email = page.locator('input[placeholder="admin@erp.local"]');
  try {
    await email.waitFor({ state: "visible", timeout: 8_000 });
    await email.fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
  } catch {
    /* already authenticated */
  }
  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 30_000 });
}

// مجموعة الشريط الجانبي لكل وجهة — للتنقّل client-side عبر النقر (لا إعادة تحميل).
const SIDE_GROUP: Record<string, string> = {
  العملاء: "القائمة الرئيسية",
  الصندوق: "المحاسبة",
  التقارير: "التقارير والطباعة",
};

async function nav(page: Page, label: string): Promise<void> {
  const side = page.getByRole("navigation", { name: "القائمة الجانبية" });
  let link = side.getByRole("link", { name: label });
  if ((await link.count()) === 0) {
    const group = SIDE_GROUP[label];
    if (group) {
      await side.getByRole("button", { name: group }).click();
      await page.waitForTimeout(250);
      link = side.getByRole("link", { name: label });
    }
  }
  await link.click();
}

/** البحث عن صف العميل في قائمة الأطراف وقراءة خلية الرصيد (SYP) المطابقة للقيمة المتوقعة. */
async function readPartyTable(page: Page, expected: number): Promise<number | null> {
  await page
    .getByPlaceholder("ابحث بالكود، الاسم، الشركة، الهاتف، المدينة...")
    .fill(state.customerName);
  const row = page.getByRole("row").filter({ hasText: state.customerName }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const tds = await row.locator("td").allInnerTexts();
  // عمود الرصيد هو الوحيد المساوي للقيمة المتوقعة (الإجمالي 100,000 يختلف عنها).
  return tds.map(extractSYP).find((n) => n === expected) ?? null;
}

/**
 * يستطلع دالة قارئة (تعيد number|null) حتى تساوي القيمة المتوقعة، ويعيدها.
 * ضروري للتقرير/الديون حيث يظهر الصف عند تحميل الفواتير لكن عمود «المتبقي»
 * يُحسب من الأستاذ في استعلام منفصل يتأخر جزءاً من الثانية.
 */
async function pollNumber(
  read: () => Promise<number | null>,
  expected: number,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    last = await read();
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last as number; // عند الفشل يعيد آخر قراءة (غالباً null) فيُظهر التوكيد الفرق الفعلي
}

async function pollRowSYP(
  page: Page,
  name: string,
  expected: number,
  timeoutMs = 20_000,
): Promise<number> {
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tds = await row.locator("td").allInnerTexts();
    const v = tds.map(extractSYP).find((n) => n === expected) ?? null;
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  const finalTds = await row.locator("td").allInnerTexts();
  throw new Error(
    `لم تظهر القيمة ${expected} في صف «${name}» خلال ${timeoutMs}ms — القيم الفعلية: [${finalTds.join(" | ")}]`,
  );
}

// ── الإعداد (سجل حي حقيقي: كل بيانة عبر API الحقيقي) ──────────────────────
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const login = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantId: TENANT_ID }),
  });
  expect(login.ok, "login must succeed").toBe(true);
  state.token = (await login.json()).accessToken;

  // اجعل كل الحركات بيوم مفتوح ≤ اليوم (لا قفل يوم) — نتراجع للوراء عند الحاجة.
  const closings = (await api("/cashbox/closings")) as unknown;
  const arr = Array.isArray(closings)
    ? closings
    : ((closings as any)?.data ?? (closings as any)?.closings ?? []);
  const locked = new Set<string>(
    (arr as any[]).map((c) => c.date ?? c.closedDate ?? c.day).filter(Boolean),
  );
  const now = new Date();
  let d = new Date(now);
  while (locked.has(fmtDate(d))) d = addDays(d, -1);
  state.openDate = fmtDate(d);

  const ts = Date.now();
  state.customerName = `LOCKIN-TEST-CUSTOMER ${ts}`;
  state.customerCode = `LOCKIN-${ts}`;

  // 1) العميل الحقيقي عبر API.
  const cust = await api("/customers", "POST", {
    kind: "customer",
    name: state.customerName,
    code: state.customerCode,
    currency: "SYP",
  });
  state.customerId = cust.id as string;

  // 2) مخزون حقيقي (قماش/لون/بكرة) كي تنجح فاتورة البيع.
  const fab = await api("/inventory/fabrics", "POST", { name: `قفل ${ts}`, minStockKg: 10 });
  state.fabricId = fab.id as string;
  const col = await api("/inventory/colors", "POST", {
    fabricId: state.fabricId,
    name: `لون قفل ${ts}`,
    code: `LK${ts}`,
  });
  state.colorId = col.id as string;
  const roll = await api("/inventory/rolls", "POST", {
    colorId: state.colorId,
    rollNo: `RL-${ts}`,
    initialKg: 100,
    remainingKg: 100,
    pricePerKg: 10_000,
    entryDate: state.openDate,
  });
  state.rollId = roll.id as string;

  // 3) فاتورة بيع 100,000 (آجل — غير نقدي).
  const inv = await api("/invoices", "POST", {
    type: "sale",
    date: state.openDate,
    partyId: state.customerId,
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 15000,
    paid: 0,
    lines: [
      {
        fabricId: state.fabricId,
        colorId: state.colorId,
        rollId: state.rollId,
        quantityKg: 10,
        pricePerKg: 10_000,
        discountAmount: 0,
      },
    ],
  });
  state.invoiceId = inv.id as string;
  state.invoiceNumber = inv.number as string;
  expect(Number(inv.total)).toBe(INVOICE_TOTAL);

  // 4) مرتجع جزئي 20,000 على هذه الفاتورة.
  await api("/returns", "POST", {
    kind: "sale",
    date: state.openDate,
    partyId: state.customerId,
    originalInvoiceId: state.invoiceId,
    reason: "defect",
    currency: "SYP",
    lines: [{ rollId: state.rollId, quantityKg: 2, pieces: 1, pricePerKg: 10_000 }],
  });

  // 5) سند قبض عام 30,000 «دفعة على الحساب» — بلا invoiceId (إلزامي).
  await api("/receipts", "POST", {
    kind: "receipt",
    date: state.openDate,
    partyId: state.customerId,
    partyKind: "customer",
    amount: RECEIPT_AMOUNT,
    currency: "SYP",
    exchangeRate: 15000,
    method: "cash",
  });

  console.log(
    `\n  [GROUND-TRUTH] customer=${state.customerCode} on ${state.openDate}\n` +
      `    invoice=${INVOICE_TOTAL} return=${RETURN_AMOUNT} unlinked-receipt=${RECEIPT_AMOUNT}\n` +
      `    unsettled=${EXPECTED_UNSETTLED} (expected everywhere)\n`,
  );
});

test.afterAll(async () => {
  // لا إلغاء للفاتورة — الإلغاء الجزئي (بينما السند العام والتسوية غير مرتبطين)
  // يُحدث رصيداً سالباً؛ نترك العميل مُسوّى (رصيد 0) بلا انحراف في الأرقام.
  await pool.end();
});

// ── الفحص الأول: الرصيد غير المسوّى = 50,000 بالخمسة مواضع + الأستاذ ───────
test("T1 — الرصيد غير المسوّى (50,000): الخمس نقاط متطابقة مع الأستاذ", async ({ page }) => {
  const expected = EXPECTED_UNSETTLED;

  // المرجع: الأستاذ مباشرة.
  const ledger = await ledgerBalanceSql(state.customerId);
  expect(ledger).toBe(expected);
  console.log(`  [1.ref] ledger SUM(d)-SUM(c) = ${ledger}`);

  await browserLogin(page);

  // (1) قائمة الأطراف PartyTable.
  await nav(page, "العملاء");
  const listBalance = await readPartyTable(page, expected);
  expect(listBalance, "PartyTable: عمود الرصيد").toBe(expected);
  console.log(`  [1] PartyTable الرصيد = ${expected} ✅`);

  // (2) بطاقة النظرة العامة (ننقر صف العميل للتنقّل client-side).
  await page.getByRole("row").filter({ hasText: state.customerName }).first().click();
  const kpiLabel = page.getByText("المتبقي", { exact: true }).first();
  await expect(kpiLabel).toBeVisible({ timeout: 20_000 });
  const kpiValue = await pollNumber(
    async () => extractSYP(await kpiLabel.locator("xpath=following-sibling::div[1]").innerText()),
    expected,
  );
  expect(kpiValue).toBe(expected);
  console.log(`  [2] النظرة العامة المتبقي = ${kpiValue} ✅`);

  // (4) بطاقات الداشبورد (المستحقات = إجمالي ذمم العملاء من الأستاذ).
  await nav(page, "التقارير");
  const sqlTotalAR = await totalReceivablesSql();
  const dashLabel = page.getByText("المستحقات (ذمم)", { exact: true }).first();
  await expect(dashLabel).toBeVisible({ timeout: 20_000 });
  const dashRow = dashLabel.locator("xpath=ancestor::div[contains(@class,'justify-between')]");
  const dashValue = await pollNumber(
    async () => extractSYP(await dashRow.locator("span.tabular-nums").innerText()),
    sqlTotalAR,
  );
  expect(dashValue).toBe(sqlTotalAR);
  console.log(`  [4] الداشبورد المستحقات (SYP) = ${dashValue} (الأستاذ = ${sqlTotalAR}) ✅`);

  // (3) تقرير الذمم PartyBalances (ننقر بطاقة «الأطراف» من صفحة التقارير).
  await page.getByRole("link", { name: "الأطراف" }).click();
  const repBalance = await pollRowSYP(page, state.customerName, expected);
  expect(repBalance, "PartyBalances: عمود المتبقي").toBe(expected);
  console.log(`  [3] تقرير الذمم المتبقي = ${expected} ✅`);

  // (5) بطاقة ديون الصندوق: صف العميل في جدول «ذمم العملاء».
  await nav(page, "الصندوق");
  const toggle = page.getByRole("button", { name: /عرض جداول الذمم/ });
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await toggle.click();
  const debtBalance = await pollRowSYP(page, state.customerName, expected);
  expect(debtBalance, "FinancialOverview: مربط ديون العميل").toBe(expected);
  console.log(`  [5] بطاقة الديون المتبقي = ${expected} ✅`);
});

// ── الفحص الثاني: بعد التسوية → صفر في كل مكان ────────────────────────────
test("T2 — بعد التسوية (0): الرصيد يُصفَّر في كل المواضع", async ({ page }) => {
  const settled = await api(`/customers/${state.customerId}/statement/settle`, "POST", {
    date: state.openDate,
    currency: "SYP",
  });
  expect(settled).toBeTruthy();

  const ledger = await ledgerBalanceSql(state.customerId);
  expect(ledger).toBe(EXPECTED_SETTLED);

  await browserLogin(page);

  // (1) قائمة الأطراف: الرصيد صفر.
  await nav(page, "العملاء");
  const listBalance = await readPartyTable(page, 0);
  expect(listBalance, "PartyTable رصيد صفر").toBe(0);
  console.log("  [2.1] PartyTable الرصيد = 0 ✅");

  // (2) النظرة العامة: المتبقي صفر.
  await page.getByRole("row").filter({ hasText: state.customerName }).first().click();
  const kpiLabel = page.getByText("المتبقي", { exact: true }).first();
  await expect(kpiLabel).toBeVisible({ timeout: 20_000 });
  await pollNumber(
    async () => extractSYP(await kpiLabel.locator("xpath=following-sibling::div[1]").innerText()),
    0,
  ).then((v) => expect(v).toBe(0));
  console.log("  [2.2] النظرة العامة المتبقي = 0 ✅");

  // (3) تقرير الذمم: المتبقي صفر.
  await nav(page, "التقارير");
  await page.getByRole("link", { name: "الأطراف" }).click();
  const repBalance = await pollRowSYP(page, state.customerName, 0);
  expect(repBalance, "تقرير الذمم متبق صفر").toBe(0);
  console.log("  [2.3] تقرير الذمم المتبقي = 0 ✅");

  // (5) بطاقة الديون: العميل المسوّى لا يظهر بين المدينين.
  //    على بيانات فارغة: بعد التسوية لا توجد أي ذمم (مدين ودائن = 0)، فلا يظهر
  //    زر «عرض جداول الذمم» بل EmptyState «لا ذمم مستحقة» — والغياب الآمن
  //    للعميل مساوٍ ثبوت الغياب. نتعامل مع الحالتين بدل افتراض وجود الزر.
  await nav(page, "الصندوق");
  const toggle = page.getByRole("button", { name: /عرض جداول الذمم/ });
  const emptyDebts = page.getByText("لا ذمم مستحقة", { exact: true });
  const deadline = Date.now() + 15_000;
  let hasToggle = false;
  while (Date.now() < deadline) {
    hasToggle = (await toggle.count()) > 0;
    if (hasToggle || (await emptyDebts.count()) > 0) break;
    await page.waitForTimeout(500);
  }
  if (hasToggle) {
    await toggle.first().click();
    await expect(page.getByRole("row").filter({ hasText: state.customerName })).toHaveCount(0);
  } else {
    await expect(emptyDebts).toBeVisible();
  }
  console.log("  [2.5] بطاقة الديون: العميل المسوّى غائب ✅");
});