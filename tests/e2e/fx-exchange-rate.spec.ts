import { test, expect, chromium, type Page } from "@playwright/test";
import type { Browser } from "@playwright/test";

/**
 * FX exchange-rate browser regressions (real UI only).
 *
 * These are the PERMANENT Playwright versions of the four browser-verified
 * exchange-rate fixes. Every action goes through the real React UI (fill the
 * actual form, click the actual save button, intercept the real network call)
 * — never a hand-crafted API call. Direct SQL/API read-back is used only to
 * prove the browser action's side-effect landed in the database.
 *
 *   BUG#1 entry  — invoice create must persist exchangeRate + baseTotal (entry).
 *   BUG#1 sale   — same for a sale invoice via the sale form.
 *   BUG#2 return — the return API must RETURN exchangeRate/baseTotal (not null).
 *   BUG#3 ledger — purchase return must CREDIT the supplier (balance decreases).
 *
 * The suite is serial: one login, and each test builds on the previous one
 * (entry creates the roll the sale/return reuse; the return feeds the statement
 * assertion). Login is performed once in beforeAll to respect the auth
 * rate-limit (5 logins / 15 min / IP+email).
 */

const FRONTEND = process.env.PLAYWRIGHT_FRONTEND_URL ?? "http://localhost:5173";
const EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? "admin@erp.local";
const PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? "FxTest@2026!";

const MARK = `FXE2E-${Date.now().toString(36).toUpperCase()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Shared serial state
// ─────────────────────────────────────────────────────────────────────────────
let browser: Browser;
let page: Page;
const state = {
  supplierId: "",
};

async function login(p: Page): Promise<void> {
  await p.goto(`${FRONTEND}/`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('input[type="password"]', { timeout: 20_000 });
  await p.fill('input[type="text"]', EMAIL);
  await p.fill('input[type="password"]', PASSWORD);
  await p.click('button[type="submit"]');
  await p.waitForSelector("text=لوحة التحكم", { timeout: 30_000 });
}

test.describe.serial("FX exchange-rate browser regressions", () => {
  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    await login(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG#1 — entry invoice create persists the frozen exchange rate + base total
  // ───────────────────────────────────────────────────────────────────────────
  test("BUG#1 entry: create persists exchangeRate/baseTotal on entry invoice", async () => {
    await page.goto(`${FRONTEND}/invoices/entry/new`, { waitUntil: "domcontentloaded" });
    await sleep(3500);

    // Supplier quick-add (type-to-create).
    await page.locator('button:has-text("اختر المورد")').first().click();
    await sleep(400);
    await page.getByPlaceholder("ابحث أو اكتب اسم مورد جديد...").first().fill(`${MARK}-SUP`);
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.locator('button:has-text("حفظ وتحديد")').first().click();
    await sleep(1800);

    // Line card — type only (no Enter, to avoid spawning a second card).
    await page.getByLabel("القماش").first().fill(`${MARK}-FAB`);
    await sleep(500);
    await page.getByLabel("اسم اللون").first().fill(`${MARK}-COL`);
    await sleep(500);
    await page.getByLabel("الوزن الصافي").first().fill("100");
    await sleep(300);
    await page.getByLabel("سعر الوحدة").first().fill("1000");
    await sleep(300);
    // 3 pieces so the same roll can absorb one sale (1) + one return (1).
    await page.getByLabel("عدد الأثواب").first().fill("3");
    await sleep(300);
    await page.getByPlaceholder("مثلاً 15000").first().fill("10000");
    await sleep(300);

    // Collapse any spurious extra cards (keep one line).
    while ((await page.locator('button[aria-label="حذف الصبغة"]').count()) > 1) {
      await page.locator('button[aria-label="حذف الصبغة"]').last().click();
      await sleep(400);
    }

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/invoices") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ الفاتورة")').first().click(),
    ]);

    const reqBody = JSON.parse(response.request().postData() ?? "{}");
    const respBody = await response.json();

    expect(response.status()).toBe(201);
    expect(reqBody.exchangeRate).toBe(10000); // frozen rate reached the API
    expect(respBody.exchangeRate).toBe(10000); // …and round-trips back
    expect(respBody.baseTotal).toBe(10); // 100kg × 1000 / 10000
    expect(respBody.partyId).toBeTruthy();
    state.supplierId = respBody.partyId;
    await sleep(2000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG#1 — sale invoice create persists the frozen rate + base total
  // ───────────────────────────────────────────────────────────────────────────
  test("BUG#1 sale: create persists exchangeRate/baseTotal on sale invoice", async () => {
    await page.goto(`${FRONTEND}/invoices/sale/new`, { waitUntil: "domcontentloaded" });
    await sleep(3500);

    // Currency = SYP, then the rate field appears.
    await page.locator('button[role="combobox"]:has-text("اختر العملة")').first().click();
    await sleep(400);
    await page.locator('[role="option"]').filter({ hasText: /ل\.س/ }).first().click();
    await sleep(400);
    await page.getByPlaceholder("مثلاً 15000").first().fill("15000");
    await sleep(300);

    // Customer quick-add (dialog).
    await page.locator('button[title="عميل جديد سريع"]').first().click();
    await sleep(600);
    await page.locator('[role="dialog"] input').first().fill(`${MARK}-CUS`);
    await sleep(300);
    await page.locator('[role="dialog"] button:has-text("حفظ وتحديد")').first().click();
    await sleep(1800);

    // Line: fabric + color (Enter commits each) then the available roll.
    await page.getByLabel("القماش").first().fill(`${MARK}-FAB`);
    await sleep(600);
    await page.getByLabel("القماش").first().press("Enter");
    await sleep(600);
    await page.getByLabel("اسم اللون").first().fill(`${MARK}-COL`);
    await sleep(600);
    await page.getByLabel("اسم اللون").first().press("Enter");
    await sleep(600);
    await page.locator('button[role="combobox"]:has-text("اختر صبغة")').first().click();
    await sleep(400);
    await page.locator('[role="option"]:has-text("متاح")').first().click();
    await sleep(500);
    await page.getByLabel("الكمية").first().fill("50");
    await sleep(300);
    await page.getByLabel("سعر الوحدة").first().fill("1500");
    await sleep(300);

    // Collapse any spurious extra cards (keep one line).
    while ((await page.locator('button[aria-label="حذف البند"]').count()) > 1) {
      await page.locator('button[aria-label="حذف البند"]').last().click();
      await sleep(400);
    }

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/invoices") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ الفاتورة")').first().click(),
    ]);

    const reqBody = JSON.parse(response.request().postData() ?? "{}");
    const respBody = await response.json();

    expect(response.status()).toBe(201);
    expect(reqBody.exchangeRate).toBe(15000);
    expect(reqBody.partyType).toBe("customer");
    expect(respBody.exchangeRate).toBe(15000);
    expect(respBody.baseTotal).toBe(5); // 50kg × 1500 / 15000
    await sleep(2000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG#2 — return API returns exchangeRate/baseTotal (were null)
  // ───────────────────────────────────────────────────────────────────────────
  test("BUG#2 return: return API returns the frozen exchangeRate/baseTotal", async () => {
    await page.goto(`${FRONTEND}/returns/entry/new`, { waitUntil: "domcontentloaded" });
    await sleep(3500);

    // Party = the supplier created in the BUG#1-entry test.
    await page.locator('button[role="combobox"]:has-text("اختر...")').first().click();
    await sleep(500);
    await page.locator(`[role="option"]:has-text("${MARK}-SUP")`).first().click();
    await sleep(600);

    await page.locator('button:has-text("إضافة بند")').first().click();
    await sleep(500);
    await page.locator('button[role="combobox"]:has-text("اختر صبغة")').first().click();
    await sleep(500);
    await page.locator(`[role="option"]:has-text("${MARK}-COL")`).first().click();
    await sleep(600);
    await page.locator('tbody input[type="number"][step="0.01"]').first().fill("10");
    await sleep(400);

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/returns") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ المرتجع")').first().click(),
    ]);

    const respBody = await response.json();
    expect(response.status()).toBe(201);
    expect(respBody.exchangeRate).not.toBeNull();
    expect(respBody.exchangeRate).toBe(10000); // derived from the entry invoice
    expect(respBody.baseTotal).not.toBeNull();
    expect(respBody.baseTotal).toBe(1); // 10kg × 1000 / 10000
    await sleep(2000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BUG#3 — purchase return CREDITS the supplier (balance decreases)
  // ───────────────────────────────────────────────────────────────────────────
  test("BUG#3 statement: purchase return credits the supplier balance", async () => {
    await page.goto(`${FRONTEND}/suppliers/${state.supplierId}`, { waitUntil: "domcontentloaded" });
    await sleep(3000);

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/statement") &&
          r.request().method() === "GET" &&
          !r.url().includes("/settle"),
        { timeout: 20_000 },
      ),
      page.locator('button:has-text("كشف حساب")').first().click(),
    ]);

    const stmt = await response.json();

    // Entry invoice DEBITS 100,000; return CREDITS 10,000 → final 90,000.
    expect(stmt.currency).toBe("SYP");
    expect(stmt.totalDebit).toBe(100000);
    expect(stmt.totalCredit).toBe(10000);

    const invoiceRow = stmt.entries.find((e: any) => e.type === "purchase_invoice");
    const returnRow = stmt.entries.find((e: any) => e.type === "purchase_return");
    expect(invoiceRow).toBeTruthy();
    expect(invoiceRow.debit).toBe(100000);
    expect(returnRow).toBeTruthy();
    expect(returnRow.debit).toBe(0); // was 10000 before the fix (wrong direction)
    expect(returnRow.credit).toBe(10000); // credit DECREASES the balance
    expect(stmt.finalBalance).toBe(90000); // 100,000 − 10,000
  });
});