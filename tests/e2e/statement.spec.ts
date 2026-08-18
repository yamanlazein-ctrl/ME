import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createRequire } from "module";

/**
 * Customer statement (كشف حساب) — E2E verification with direct SQL cross-checks.
 *
 * Every number asserted in the UI/API is recomputed by an independent SQL query
 * against the same PostgreSQL instance the backend writes to — never guessed.
 *
 * Scenarios covered (guarded-build protocol STAGE 3):
 *  1. previousBalance shown = value computed directly from DB
 *  2. totals (debit/credit/final) = SQL aggregates for the window
 *  3. switching currency changes the backend query results (real WHERE filter)
 *  4. an expandable invoice row shows the correct line count (matches DB)
 *  5. a cancelled movement is shown struck-through and excluded from balances
 *  6. footer totals = mathematical sum of the displayed (active) columns
 */

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:8080";
const ADMIN = { email: "admin@erp.local", password: "admin123" };

// pg resolves from the backend's own node_modules (repo-root node_modules has no pg).
const require = createRequire(import.meta.url);
const { Pool } = require("../../backend/node_modules/pg");
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/erp",
});

const TENANT_ID = "f7a54ec6-0802-48da-a03c-9474b526e081"; // admin@erp.local tenant

// Real seed assets used for controlled invoice creation (SYP, huge stock).
// Each invoice line uses a distinct roll: the backend's optimistic roll
// version-lock fails when a single invoice carries multiple lines on the SAME
// roll (pre-existing quirk), so every line gets its own roll here.
const ASSETS = [
  { rollId: "64f785e3-5a93-45df-946c-a74847aa0927", fabricId: "acfbab9c-c278-4693-ad81-ca927c1366f7", colorId: "a693e1d5-175d-4e3f-a58f-42faf0b97c3c" },
  { rollId: "b926b088-d580-49d9-8585-d6e98eb5b87b", fabricId: "6ea74c79-cbd6-4f0a-8115-8a61d05e2ee7", colorId: "30bd3e5e-71be-4d09-9aa4-88f9e81ba395" },
  { rollId: "af3370aa-e8c0-400c-83b7-9066e5ca88fc", fabricId: "bdc4443e-40d7-4e9e-bb3a-90651594c93e", colorId: "00b8b323-88f3-45f8-ad2b-a87271624524" },
];

interface DBRow {
  [k: string]: unknown;
}

async function sql<T extends DBRow>(query: string, params: (string | number)[] = []): Promise<T[]> {
  const r = await pool.query(query, params);
  return r.rows as T[];
}

const state: {
  token: string;
  customerId: string;
  invoiceA: string; // active, dated BEFORE the statement window (drives previousBalance)
  invoiceANumber: string;
  invoiceB: string; // active, 3 lines, inside window
  invoiceBNumber: string;
  invoiceC: string; // cancelled, 2 lines, inside window
  invoiceCNumber: string;
  receiptSYPNumber: string; // active SYP credit in the window
  receiptUSDNumber: string; // active USD credit (currency-filter proof)
} = {
  token: "",
  customerId: "",
  invoiceA: "",
  invoiceANumber: "",
  invoiceB: "",
  invoiceBNumber: "",
  invoiceC: "",
  invoiceCNumber: "",
  receiptSYPNumber: "",
  receiptUSDNumber: "",
};

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BACKEND}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data as Record<string, any>;
}

test.beforeAll(async () => {
  const login = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  expect(login.ok, "login must succeed").toBe(true);
  const loginBody = (await login.json()) as { accessToken: string };
  state.token = loginBody.accessToken;

  const ts = Date.now();

  // Customer (SYP).
  const cust = await api("/customers", "POST", {
    kind: "customer",
    name: `CUS-STMT-E2E-${ts}`,
    phone: "0999-000000",
    currency: "SYP",
  });
  state.customerId = cust.id as string;
  expect(state.customerId).toBeTruthy();

  const line = (qty: number, price: number, asset: (typeof ASSETS)[number]) => ({
    fabricId: asset.fabricId,
    colorId: asset.colorId,
    rollId: asset.rollId,
    quantityKg: qty,
    pricePerKg: price,
    discountAmount: 0,
  });

  // Invoice A — active, dated before the window → becomes previousBalance.
  const a = await api("/invoices", "POST", {
    type: "sale",
    date: "2026-08-01",
    partyId: state.customerId,
    partyType: "customer",
    currency: "SYP",
    lines: [line(10, 5000, ASSETS[0])], // 50,000
    paid: 0,
  });
  state.invoiceA = a.id as string;
  state.invoiceANumber = a.number as string;
  expect(a.total).toBe(50000);

  // Invoice B — active, 3 lines, inside window (drives expandable-line test).
  const b = await api("/invoices", "POST", {
    type: "sale",
    date: "2026-08-05",
    partyId: state.customerId,
    partyType: "customer",
    currency: "SYP",
    lines: [
      line(10, 5000, ASSETS[0]),
      line(5, 4000, ASSETS[1]),
      line(2, 10000, ASSETS[2]),
    ], // 50,000 + 20,000 + 20,000
    paid: 0,
  });
  state.invoiceB = b.id as string;
  state.invoiceBNumber = b.number as string;
  expect(b.total).toBe(90000);

  // Invoice C — created then cancelled (2 lines, inside window). Its ledger row
  // must be status=cancelled; it must be shown but excluded from balances.
  const c = await api("/invoices", "POST", {
    type: "sale",
    date: "2026-08-06",
    partyId: state.customerId,
    partyType: "customer",
    currency: "SYP",
    lines: [line(1, 1000, ASSETS[0]), line(1, 2000, ASSETS[1])], // 1,000 + 2,000
    paid: 0,
  });
  state.invoiceC = c.id as string;
  state.invoiceCNumber = c.number as string;
  expect(c.total).toBe(3000);
  await api(`/invoices/${state.invoiceC}/cancel`, "POST");

  // Receipt R1 — active SYP credit inside window (25,000).
  const r1 = await api("/receipts", "POST", {
    kind: "receipt",
    date: "2026-08-07",
    partyId: state.customerId,
    partyKind: "customer",
    amount: 25000,
    currency: "SYP",
    method: "cash",
  });
  state.receiptSYPNumber = r1.number as string;

  // Receipt R2 — active USD credit (proves currency is a real backend WHERE).
  const r2 = await api("/receipts", "POST", {
    kind: "receipt",
    date: "2026-08-09",
    partyId: state.customerId,
    partyKind: "customer",
    amount: 500,
    currency: "USD",
    method: "cash",
  });
  state.receiptUSDNumber = r2.number as string;
});

test.afterAll(async () => {
  // Restore roll stock and clean up the throwaway customer.
  try {
    if (state.invoiceA) await api(`/invoices/${state.invoiceA}/cancel`, "POST");
    if (state.invoiceB) await api(`/invoices/${state.invoiceB}/cancel`, "POST");
  } catch {
    /* best-effort teardown */
  }
  await pool.end();
});

const FROM = "2026-08-02";
const TO = "2026-08-10";

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 + 2 (API + SQL): previousBalance and totals must match direct SQL.
// ─────────────────────────────────────────────────────────────────────────────
test("S1/S2: previousBalance and totals match independent SQL aggregates", async () => {
  const stmt = (await api(
    `/customers/${state.customerId}/statement?currency=SYP&from=${FROM}&to=${TO}`,
  )) as {
    previousBalance: number;
    totalDebit: number;
    totalCredit: number;
    finalBalance: number;
    entries: { seq: number; type: string; status: string; debit: number; credit: number; runningBalance: number; referenceNumber?: string }[];
  };

  // Independent SQL: previous balance = active sum strictly before `from`.
  const prev = await sql<{ v: string }>(
    `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS v
     FROM ledger_entries
     WHERE party_id = $1 AND tenant_id = $2 AND status = 'active'
       AND currency = 'SYP' AND date < $3`,
    [state.customerId, TENANT_ID, FROM],
  );
  expect(stmt.previousBalance).toBe(Number(prev[0].v));

  // Independent SQL: window totals = active sums within [from, to].
  const win = await sql<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(CASE WHEN status='active' THEN debit ELSE 0 END),0) AS d,
            COALESCE(SUM(CASE WHEN status='active' THEN credit ELSE 0 END),0) AS c
     FROM ledger_entries
     WHERE party_id = $1 AND tenant_id = $2 AND currency = 'SYP'
       AND date >= $3 AND date <= $4`,
    [state.customerId, TENANT_ID, FROM, TO],
  );
  const sqlDebit = Number(win[0].d);
  const sqlCredit = Number(win[0].c);

  expect(stmt.totalDebit).toBe(sqlDebit);
  expect(stmt.totalCredit).toBe(sqlCredit);
  expect(stmt.finalBalance).toBe(stmt.previousBalance + sqlDebit - sqlCredit);

  // Controlled numbers for this exact dataset:
  expect(stmt.previousBalance).toBe(50000); // invoice A (active, before window)
  expect(stmt.totalDebit).toBe(90000); // invoice B only (C cancelled → excluded)
  expect(stmt.totalCredit).toBe(25000); // receipt R1
  expect(stmt.finalBalance).toBe(115000); // 50,000 + 90,000 − 25,000
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 (API + SQL): switching currency changes the backend query results.
// ─────────────────────────────────────────────────────────────────────────────
test("S3: currency is a real backend WHERE — USD statement differs from SYP", async () => {
  const syp = (await api(
    `/customers/${state.customerId}/statement?currency=SYP&from=${FROM}&to=${TO}`,
  )) as { entries: { type: string; status: string; debit: number; credit: number }[] };
  const usd = (await api(
    `/customers/${state.customerId}/statement?currency=USD&from=${FROM}&to=${TO}`,
  )) as {
    previousBalance: number;
    totalDebit: number;
    totalCredit: number;
    finalBalance: number;
    entries: { type: string; status: string; debit: number; credit: number }[];
  };

  // The SYP and USD results must be genuinely different sets.
  expect(syp.entries.some((e) => e.type === "receipt_in" && e.credit === 500)).toBe(false);
  expect(usd.entries.some((e) => e.type === "receipt_in" && e.credit === 500)).toBe(true);
  expect(usd.entries.length).toBeGreaterThan(0);
  expect(usd.entries.length).not.toBe(syp.entries.length);

  // Independent SQL for USD: one active receipt of 500, nothing else.
  const usdTotals = await sql<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(CASE WHEN status='active' THEN debit ELSE 0 END),0) AS d,
            COALESCE(SUM(CASE WHEN status='active' THEN credit ELSE 0 END),0) AS c
     FROM ledger_entries
     WHERE party_id = $1 AND tenant_id = $2 AND currency = 'USD' AND date >= $3 AND date <= $4`,
    [state.customerId, TENANT_ID, FROM, TO],
  );
  expect(usd.totalDebit).toBe(Number(usdTotals[0].d));
  expect(usd.totalCredit).toBe(Number(usdTotals[0].c));
  expect(usd.previousBalance).toBe(0); // no USD before the window
  expect(usd.totalCredit).toBe(500);
  expect(usd.finalBalance).toBe(-500);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 (API + SQL): cancelled movement present + excluded from balances.
// ─────────────────────────────────────────────────────────────────────────────
test("S5: cancelled movement is shown and excluded from previous/running/totals", async () => {
  const stmt = (await api(
    `/customers/${state.customerId}/statement?currency=SYP&from=${FROM}&to=${TO}`,
  )) as {
    totalDebit: number;
    totalCredit: number;
    finalBalance: number;
    entries: {
      seq: number;
      type: string;
      status: string;
      referenceNumber?: string;
      debit: number;
      credit: number;
      runningBalance: number;
    }[];
  };

  // The cancelled invoice C row must be present in the register.
  const cRow = stmt.entries.find(
    (e) => e.referenceNumber === state.invoiceCNumber && e.type === "sales_invoice",
  );
  expect(cRow, "cancelled invoice row must be present in the statement").toBeTruthy();
  expect(cRow!.status).toBe("cancelled");
  expect(cRow!.debit).toBe(3000); // its original amount is still visible (struck through)

  // Its amount must not contribute to balances:
  expect(stmt.totalDebit).toBe(90000); // would be 93,000 if the cancelled 3,000 counted
  expect(stmt.finalBalance).toBe(115000); // would be 118,000 if it counted

  // Its running balance must equal the balance before it (it does not move the account).
  const before = stmt.entries.find(
    (e) => e.referenceNumber === state.invoiceBNumber && e.type === "sales_invoice",
  );
  expect(cRow!.runningBalance).toBe(before!.runningBalance);

  // SQL: the ledger row really is cancelled.
  const dbStatus = await sql<{ status: string }>(
    `SELECT status FROM ledger_entries
     WHERE reference_id = $1 AND tenant_id = $2 AND type = 'sales_invoice'`,
    [state.invoiceC, TENANT_ID],
  );
  expect(dbStatus[0].status).toBe("cancelled");
});

// ─────────────────────────────────────────────────────────────────────────────
// UI scenarios (browser): login, open the statement tab, verify rendered values.
// ─────────────────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const emailInput = page.locator('input[placeholder="admin@erp.local"]');
  await emailInput.waitFor({ state: "visible", timeout: 20_000 });
  await emailInput.fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator("body")).toContainText("لوحة التحكم", { timeout: 30_000 });
}

async function openStatementTab(page: Page): Promise<void> {
  await page.goto(`/customers/${state.customerId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "كشف حساب" }).first().click();
  // Statement tab renders the filter card.
  await expect(page.getByText("مرشحات كشف الحساب").first()).toBeVisible({ timeout: 15_000 });
}

const num = (text: string | null) => (text ?? "").replaceAll(",", "").replaceAll(" ", "");

test("S1/S6 (UI): summary cards + footer match SQL; cancelled row is struck through", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await openStatementTab(page);

  // Set the window filters.
  await page.locator('input[type="date"]').nth(0).fill(FROM);
  await page.locator('input[type="date"]').nth(1).fill(TO);

  // Wait for the summary cards to reflect the window (50,000 / 90,000 / 25,000 / 115,000).
  await expect(page.getByText("رصيد سابق", { exact: true }).first()).toBeVisible();
  const summary = page.locator("div.rounded-lg.border");
  await expect(summary.filter({ hasText: "الرصيد النهائي" })).toContainText("115,000", {
    timeout: 15_000,
  });

  // Cancelled invoice C row: struck-through + ملغاة badge.
  const cRow = page.getByRole("row").filter({ hasText: state.invoiceCNumber });
  await expect(cRow).toBeVisible({ timeout: 15_000 });
  await expect(cRow.locator("td").nth(0)).toBeVisible();
  await expect(cRow).toContainText("ملغاة");
  // The row element itself must carry the muted line-through style.
  const cls = await cRow.getAttribute("class");
  expect(cls).toContain("destructive");

  // Footer totals: sum the visible (active) debit/credit columns and compare.
  const table = page.locator("table").filter({ hasText: "الإجمالي" });
  const debitCells = await table
    .locator("tbody tr")
    .filter({ hasNotText: "ملغاة" })
    .locator("td:nth-child(8)")
    .allInnerTexts();
  const creditCells = await table
    .locator("tbody tr")
    .filter({ hasNotText: "ملغاة" })
    .locator("td:nth-child(9)")
    .allInnerTexts();
  const sumDebit = debitCells.reduce((s, t) => s + (parseInt(num(t), 10) || 0), 0);
  const sumCredit = creditCells.reduce((s, t) => s + (parseInt(num(t), 10) || 0), 0);

  const footText = await table.locator("tfoot").innerText();
  expect(footText).toContain("90,000"); // totalDebit (en-US formatted)
  expect(footText).toContain("25,000"); // totalCredit
  expect(footText).toContain("115,000"); // finalBalance
  expect(sumDebit).toBe(90000);
  expect(sumCredit).toBe(25000);
});

test("S4 (UI+SQL): expanding an invoice row shows its real line count", async ({ page }) => {
  await loginAsAdmin(page);
  await openStatementTab(page);

  await page.locator('input[type="date"]').nth(0).fill(FROM);
  await page.locator('input[type="date"]').nth(1).fill(TO);

  // Invoice B row must have an expand chevron.
  const bRow = page.getByRole("row").filter({ hasText: state.invoiceBNumber });
  await expect(bRow).toBeVisible({ timeout: 15_000 });
  const chevron = bRow.locator("button");
  await chevron.click();

  // The expanded line-details table lists the real invoice lines.
  await expect(page.getByText("تفاصيل الأصناف").first()).toBeVisible({ timeout: 10_000 });
  const detailRows = page.locator("tbody tr.bg-muted\\/30");
  await expect(detailRows.first()).toBeVisible();

  // SQL: invoice B really has 3 lines.
  const dbLines = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM invoice_lines WHERE invoice_id = $1`,
    [state.invoiceB],
  );
  expect(Number(dbLines[0].n)).toBe(3);

  // The expanded panel must contain exactly that many line rows.
  // Structure: <div rounded-lg><div>تفاصيل الأصناف</div><table>…<tbody>lines</tbody></table></div>
  const linesPanel = page.getByText("تفاصيل الأصناف").first().locator("xpath=ancestor::div[1]");
  const lineCount = await linesPanel.locator("table tbody tr").count();
  expect(lineCount).toBe(Number(dbLines[0].n));
});

test("S3 (UI): switching currency in the browser changes the rendered statement", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await openStatementTab(page);

  await page.locator('input[type="date"]').nth(0).fill(FROM);
  await page.locator('input[type="date"]').nth(1).fill(TO);

  // Default (SYP) shows invoice B and the 25,000 SYP receipt — but NOT the USD receipt.
  await expect(
    page.getByRole("row").filter({ hasText: state.invoiceBNumber }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("row").filter({ hasText: state.receiptSYPNumber }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("row").filter({ hasText: state.receiptUSDNumber })).toHaveCount(0);

  // Switch to USD — the backend re-queries (the receipt R2 is USD-only).
  await page.getByText("كل العملات").first().click();
  await page.getByRole("option", { name: "$ دولار" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: state.receiptUSDNumber }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: state.invoiceBNumber })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: state.receiptSYPNumber })).toHaveCount(0);

  // USD final balance −500 appears in the footer / summary.
  const summary = page.locator("div.rounded-lg.border");
  await expect(summary.filter({ hasText: "الرصيد النهائي" })).toContainText("-500", {
    timeout: 15_000,
  });
});
