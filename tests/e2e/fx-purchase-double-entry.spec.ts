import { test, expect, chromium, type Page } from "@playwright/test";
import type { Browser } from "@playwright/test";

/**
 * Purchase-invoice DOUBLE-ENTRY balance (real UI + ledger read-back).
 *
 * Locks the C-8/BUG-3 revert: a purchase invoice must journal a BALANCED set
 * — Dr inventory_asset T / Cr party (supplier AP) T — so Σdebit = Σcredit for
 * that exact reference (not just a global total). Without this, the party leg
 * and the inventory leg were both debits (Σdebit = 2T, Σcredit = 0): the
 * supplier statement stayed correct, but a trial balance would break.
 *
 * Drives the real React UI to create the invoice, then reads the app's
 * document timeline for that reference and asserts the ledger legs balance.
 */

const FRONTEND = process.env.PLAYWRIGHT_FRONTEND_URL ?? "http://localhost:5173";
const EMAIL = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? "admin@erp.local";
const PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? "FxTest@2026!";
const MARK = `FXDE-E2E-${Date.now().toString(36).toUpperCase()}`;
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

test.describe.serial("FX purchase-invoice double-entry balance", () => {
  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    await login(page);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test("purchase invoice journals balanced legs (Σdebit = Σcredit)", async () => {
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
    const total = Number(created.total);
    await sleep(2000);

    // Read the document's full ledger timeline (party + inventory legs) from
    // the backend's own ledger endpoint — the app's read path to ledger_entries,
    // scoped to this exact reference. Auth is a JWT kept in localStorage, so
    // replay it over Playwright's APIRequestContext (no browser CORS involved).
    const API = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:8080";
    const token = await page.evaluate(() => localStorage.getItem("erp.auth.accessToken"));
    expect(token).toBeTruthy();
    const resp = await page
      .context()
      .request.get(`${API}/api/ledger/timeline/purchase_invoice/${state.invoiceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect(resp.status()).toBe(200);
    const timeline = await resp.json();

    const rows: any[] = timeline?.data ?? [];
    const active = rows.filter((e) => e.status === "active");
    const sumDebit = active.reduce((s, e) => s + Number(e.debit ?? 0), 0);
    const sumCredit = active.reduce((s, e) => s + Number(e.credit ?? 0), 0);

    // Exactly two active legs: Dr inventory_asset / Cr party (supplier AP).
    expect(active.length).toBe(2);
    const partyLeg = active.find((e) => e.type === "purchase_invoice");
    const inventoryLeg = active.find((e) => e.type === "inventory_asset");
    expect(partyLeg).toBeTruthy();
    expect(inventoryLeg).toBeTruthy();
    expect(partyLeg.credit).toBe(total); // AP increases on the credit side
    expect(partyLeg.debit).toBe(0);
    expect(inventoryLeg.debit).toBe(total); // asset increases on the debit side
    expect(inventoryLeg.credit).toBe(0);

    // Σdebit = Σcredit for this exact reference — the double-entry invariant.
    expect(sumDebit).toBe(sumCredit);
    expect(sumDebit).toBe(total);

    // Supplier statement still shows a positive "owed" balance (credit − debit).
    await page.goto(`${FRONTEND}/suppliers/${state.supplierId}`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const [stmtResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/statement") &&
          r.request().method() === "GET" &&
          !r.url().includes("/settle"),
        { timeout: 20_000 },
      ),
      page.locator('button:has-text("كشف حساب")').first().click(),
    ]);
    const stmt = await stmtResp.json();
    expect(stmt.finalBalance).toBe(total); // positive owed, supplier convention
    expect(stmt.totalCredit).toBe(total);
    expect(stmt.totalDebit).toBe(0);
  });
});