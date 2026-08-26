import { test, expect, chromium, type Page } from "@playwright/test";
import type { Browser } from "@playwright/test";

/**
 * Purchase-invoice EDIT sign consistency (real UI only).
 *
 * Regression for the create-vs-edit ledger sign divergence: the create path
 * writes the invoice party leg as DEBIT for BOTH sale and purchase (C-8:
 * debit = obligation increases), but the edit path (invoiceLedgerLegs) used
 * to CREDIT the supplier for purchase invoices. Editing a purchase invoice
 * therefore flipped the supplier balance from +T to -T.
 *
 * This spec drives the real React UI: create a purchase invoice, edit it
 * twice, and assert the supplier statement stays positive and correct after
 * every edit (active purchase_invoice leg is always debit, never credit).
 */

const FRONTEND = process.env.PLAYWRIGHT_FRONTEND_URL ?? "http://localhost:5173";
const EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? "admin@erp.local";
const PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? "FxTest@2026!";
const MARK = `FXEDT-E2E-${Date.now().toString(36).toUpperCase()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let browser: Browser;
let page: Page;
const state = { supplierId: "", invoiceId: "" };

async function login(p: Page): Promise<void> {
  await p.goto(`${FRONTEND}/`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('input[type="password"]', { timeout: 20_000 });
  await p.fill('input[type="text"]', EMAIL);
  await p.fill('input[type="password"]', PASSWORD);
  await p.click('button[type="submit"]');
  await p.waitForSelector("text=لوحة التحكم", { timeout: 30_000 });
}

async function openStatement(p: Page): Promise<any> {
  await p.goto(`${FRONTEND}/suppliers/${state.supplierId}`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  const [resp] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.url().includes("/statement") &&
        r.request().method() === "GET" &&
        !r.url().includes("/settle"),
      { timeout: 20_000 },
    ),
    p.locator('button:has-text("كشف حساب")').first().click(),
  ]);
  return await resp.json();
}

test.describe.serial("FX purchase-invoice edit sign", () => {
  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    await login(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test("edit preserves DEBIT party leg (create → edit → edit stays positive)", async () => {
    // ── create purchase invoice: 100kg @ 1000 = 100,000 ──────────────────────
    await page.goto(`${FRONTEND}/invoices/entry/new`, { waitUntil: "domcontentloaded" });
    await sleep(3500);

    await page.locator('button:has-text("اختر المورد")').first().click();
    await sleep(400);
    await page.getByPlaceholder("ابحث أو اكتب اسم مورد جديد...").first().fill(`${MARK}-SUP`);
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.locator('button:has-text("حفظ وتحديد")').first().click();
    await sleep(1800);

    await page.getByLabel("القماش").first().fill(`${MARK}-FAB`);
    await sleep(500);
    await page.getByLabel("اسم اللون").first().fill(`${MARK}-COL`);
    await sleep(500);
    await page.getByLabel("الوزن الصافي").first().fill("100");
    await sleep(300);
    await page.getByLabel("سعر الوحدة").first().fill("1000");
    await sleep(300);
    await page.getByLabel("عدد الأثواب").first().fill("3");
    await sleep(300);
    await page.getByPlaceholder("مثلاً 15000").first().fill("10000");
    await sleep(300);
    while ((await page.locator('button[aria-label="حذف الصبغة"]').count()) > 1) {
      await page.locator('button[aria-label="حذف الصبغة"]').last().click();
      await sleep(400);
    }

    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/invoices") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ الفاتورة")').first().click(),
    ]);
    const created = await createResp.json();
    expect(createResp.status()).toBe(201);
    state.supplierId = created.partyId;
    state.invoiceId = created.id;
    await sleep(2000);

    const activeLeg = (stmt: any) =>
      stmt.entries.find((e: any) => e.type === "purchase_invoice" && e.status === "active");

    // After create: +100,000, debit.
    const stmt1 = await openStatement(page);
    expect(stmt1.finalBalance).toBe(100000);
    expect(activeLeg(stmt1).debit).toBe(100000);
    expect(activeLeg(stmt1).credit).toBe(0);

    // ── edit #1: 100kg → 150kg = 150,000 ──────────────────────────────────────
    await page.goto(`${FRONTEND}/invoices/entry/new?edit=${state.invoiceId}`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(4500);
    await page.getByLabel("الوزن الصافي").first().fill("150");
    await sleep(500);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/invoices/") && r.request().method() === "PUT",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ الفاتورة")').first().click(),
    ]);
    await sleep(2000);

    const stmt2 = await openStatement(page);
    expect(stmt2.finalBalance).toBe(150000); // stays positive — not flipped to -150,000
    expect(activeLeg(stmt2).debit).toBe(150000);
    expect(activeLeg(stmt2).credit).toBe(0);

    // ── edit #2: 150kg → 80kg = 80,000 ────────────────────────────────────────
    await page.goto(`${FRONTEND}/invoices/entry/new?edit=${state.invoiceId}`, {
      waitUntil: "domcontentloaded",
    });
    await sleep(4500);
    await page.getByLabel("الوزن الصافي").first().fill("80");
    await sleep(500);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/invoices/") && r.request().method() === "PUT",
        { timeout: 30_000 },
      ),
      page.locator('button:has-text("حفظ الفاتورة")').first().click(),
    ]);
    await sleep(2000);

    const stmt3 = await openStatement(page);
    expect(stmt3.finalBalance).toBe(80000); // stays positive through multiple edits
    expect(activeLeg(stmt3).debit).toBe(80000);
    expect(activeLeg(stmt3).credit).toBe(0);
  });
});