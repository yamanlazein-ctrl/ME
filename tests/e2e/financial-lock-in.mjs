#!/usr/bin/env node
/**
 * Financial Lock-In Integration Tests
 * ===================================
 * Permanent regression suite for three root-cause bugs that were each fixed in
 * isolation and MUST NOT be reintroduced by any future change.
 *
 * Run:  node tests/e2e/financial-lock-in.mjs
 *       (or: npm run test:financial)
 *
 * Base URL override:  ERP_API_BASE_URL=http://localhost:8083
 *
 * Each test group is self-contained (creates its own uniquely-coded data) so it
 * is safe to re-run against a live dev database without collisions.
 */

const BASE = process.env.ERP_API_BASE_URL || "http://localhost:8083";
const TENANT_ID = process.env.ERP_TENANT_ID || "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const EMAIL = process.env.ERP_ADMIN_EMAIL || "admin@erp.local";
const PASSWORD = process.env.ERP_ADMIN_PASSWORD || "GcvUIlmnyP5rZQs6rO";

let token = "";
let passed = 0;
let failed = 0;
const failures = [];

function today() { return new Date().toISOString().slice(0, 10); }
function dOff(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function api(method, endpoint, body) {
  const opts = { method, headers: { "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : undefined } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${endpoint}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`); }
}

async function test(name, fn) {
  console.log(`\n📋 ${name}`);
  try { await fn(); } catch (e) { failed++; failures.push(`${name}: ${e.message}`); console.log(`  💥 ${e.message}`); }
}

async function login() {
  token = (await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD, tenantId: TENANT_ID })).data.accessToken;
}

async function ledgerByRef(refType, refId) {
  const r = await api("GET", `/api/ledger?referenceType=${refType}&referenceId=${refId}&limit=1000`);
  return r.data?.data ?? [];
}

async function mkStock(cost = 5000, kg = 500) {
  const u = uniq();
  const fab = (await api("POST", "/api/inventory/fabrics", { name: `قماش ${u}`, minStockKg: 10 })).data;
  const col = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `لون ${u}`, code: `C${u}` })).data;
  const roll = (await api("POST", "/api/inventory/rolls", { colorId: col.id, rollNo: `R-${u}`, initialKg: kg, remainingKg: kg, pricePerKg: cost, entryDate: dOff(-5) })).data;
  return { fab, col, roll };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TEST A — Problem 1a (merged C4): double-entry ledger balance.
 * BUG IT PREVENTS: every ledger entry was written single-sided (debit=total,
 * credit=0) so Σdebit ≠ Σcredit for every business event. Discovered 2026-08-15.
 * ──────────────────────────────────────────────────────────────────────────── */
await test("Problem 1a — every transaction is double-entry balanced", async () => {
  await login();
  const u = uniq();
  const customer = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const supplier = (await api("POST", "/api/suppliers", { name: `مورد ${u}`, code: `SUPP-${u}` })).data;
  const { fab, col, roll } = await mkStock(5000, 500);

  const sale = (await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "SYP",
    lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 1000 }],
  })).data;
  const purchase = (await api("POST", "/api/invoices", {
    type: "entry", date: today(), partyId: supplier.id, partyType: "supplier", currency: "SYP",
    lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 5, pricePerKg: 800 }],
  })).data;
  const receipt = (await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: customer.id, partyKind: "customer", amount: 5000, currency: "SYP", method: "cash" })).data;
  const payment = (await api("POST", "/api/payments", { kind: "payment", date: today(), partyId: supplier.id, partyKind: "supplier", amount: 3000, currency: "SYP", method: "cash" })).data;
  const expense = (await api("POST", "/api/expenses", { category: "rent", description: "إيجار", amount: 2000, currency: "SYP", date: today(), method: "cash" })).data;

  const cases = [
    ["sales_invoice", sale.id],
    ["purchase_invoice", purchase.id],
    ["receipt_in", receipt.id],
    ["payment_out", payment.id],
    ["expense", expense.id],
  ];
  let totalBalanced = true;
  for (const [refType, refId] of cases) {
    const entries = await ledgerByRef(refType, refId);
    const debit = entries.reduce((s, e) => s + (e.debit || 0), 0);
    const credit = entries.reduce((s, e) => s + (e.credit || 0), 0);
    const hasDebit = entries.some((e) => (e.debit || 0) > 0);
    const hasCredit = entries.some((e) => (e.credit || 0) > 0);
    const balanced = debit === credit && entries.length >= 2 && hasDebit && hasCredit;
    ok(`${refType} balanced (Σdebit=Σcredit, ≥2 legs)`, balanced, `entries=${entries.length} D=${debit} C=${credit}`);
    totalBalanced = totalBalanced && balanced;
  }
  ok("All 5 transaction types balanced", totalBalanced);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * TEST B — Problem 1b: COGS journaled (Dr COGS Expense / Cr Inventory Asset).
 * BUG IT PREVENTS: profit was only a read-time dashboard formula
 * (revenue − Σ(qty×pricePerKg)) with NO ledger entry, so no auditable COGS.
 * Two colors with different costs must yield TWO distinct COGS entries.
 * Discovered 2026-08-15.
 * ──────────────────────────────────────────────────────────────────────────── */
await test("Problem 1b — COGS is journaled per color (not averaged)", async () => {
  const u = uniq();
  const customer = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const fab = (await api("POST", "/api/inventory/fabrics", { name: `قماش ${u}`, minStockKg: 5 })).data;
  const colA = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `أحمر ${u}`, code: `A${u}` })).data;
  const colB = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `أزرق ${u}`, code: `B${u}` })).data;
  const rollA = (await api("POST", "/api/inventory/rolls", { colorId: colA.id, rollNo: `RA-${u}`, initialKg: 100, remainingKg: 100, pricePerKg: 5000, entryDate: dOff(-5) })).data;
  const rollB = (await api("POST", "/api/inventory/rolls", { colorId: colB.id, rollNo: `RB-${u}`, initialKg: 100, remainingKg: 100, pricePerKg: 6000, entryDate: dOff(-5) })).data;

  const saleA = (await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "SYP",
    lines: [{ fabricId: fab.id, colorId: colA.id, rollId: rollA.id, quantityKg: 30, pricePerKg: 7000 }],
  })).data;
  const saleB = (await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "SYP",
    lines: [{ fabricId: fab.id, colorId: colB.id, rollId: rollB.id, quantityKg: 20, pricePerKg: 7000 }],
  })).data;

  const cogsA = 30 * 5000, cogsB = 20 * 6000;
  const legsA = await ledgerByRef("sales_invoice", saleA.id);
  const legsB = await ledgerByRef("sales_invoice", saleB.id);
  const cogsDebitA = legsA.filter((e) => e.type === "cogs_expense").reduce((s, e) => s + (e.debit || 0), 0);
  const cogsDebitB = legsB.filter((e) => e.type === "cogs_expense").reduce((s, e) => s + (e.debit || 0), 0);
  const invCreditA = legsA.filter((e) => e.type === "inventory_asset").reduce((s, e) => s + (e.credit || 0), 0);
  ok("Sale A COGS = 150000", cogsDebitA === cogsA, `got ${cogsDebitA}`);
  ok("Sale B COGS = 120000", cogsDebitB === cogsB, `got ${cogsDebitB}`);
  ok("Two colors → two distinct COGS entries (not averaged)", cogsA !== cogsB && cogsDebitA === cogsA && cogsDebitB === cogsB);
  ok("Inventory asset credited with COGS value", invCreditA === cogsA, `got ${invCreditA}`);

  // Profit two independent ways: dashboard vs ledger (revenue − COGS).
  const dash = (await api("GET", "/api/dashboard")).data;
  const profitDash = dash.todayProfit?.syp;
  const all = (await api("GET", "/api/ledger?limit=1000")).data?.data ?? [];
  const rev = all.filter((e) => e.type === "sales_revenue" && e.status === "active").reduce((s, e) => s + (e.credit || 0), 0);
  const cogs = all.filter((e) => e.type === "cogs_expense" && e.status === "active").reduce((s, e) => s + (e.debit || 0), 0);
  ok("Profit two ways match (dashboard == ledger revenue−COGS)", profitDash === rev - cogs, `dash=${profitDash} ledger=${rev - cogs}`);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * TEST C — Problem 2: invoice date-range filter + date ordering.
 * BUG IT PREVENTS: fromDate/toDate were accepted by the schema but silently
 * IGNORED in the repository (list ordered by createdAt), so date-range exports
 * leaked out-of-range invoices and were not chronological. Discovered 2026-08-15.
 * ──────────────────────────────────────────────────────────────────────────── */
await test("Problem 2 — invoice date filter + ordering + inclusive bounds", async () => {
  await login();
  const u = uniq();
  const customer = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const { fab, col, roll } = await mkStock(100, 1000);
  for (const off of [-2, 0, -4, -1, -3]) { // shuffled creation order
    await api("POST", "/api/invoices", {
      type: "sale", date: dOff(off), partyId: customer.id, partyType: "customer", currency: "SYP",
      lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 100 }],
    });
  }
  const range = (await api("GET", `/api/invoices?partyId=${customer.id}&fromDate=${dOff(-3)}&toDate=${dOff(-1)}&limit=1000`)).data.data;
  const dates = range.map((i) => i.date);
  ok("Range returns exactly 3 invoices", range.length === 3, `got ${range.length}`);
  ok("Range excludes out-of-range invoices", dates.every((d) => d >= dOff(-3) && d <= dOff(-1)));
  ok("Ordering is chronological by date", JSON.stringify(dates) === JSON.stringify([...dates].sort()), dates.join(","));

  const single = (await api("GET", `/api/invoices?partyId=${customer.id}&fromDate=${dOff(-2)}&toDate=${dOff(-2)}&limit=1000`)).data.data;
  ok("Inclusive boundary (from=to=-2) returns 1", single.length === 1 && single[0].date === dOff(-2), `got ${single.length}`);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * TEST D — Problem 3: transfer-method expenses reduce the cashbox.
 * BUG IT PREVENTS: cashImpact used raw input.paidFromCashbox (undefined→false),
 * so transfer-method expenses (paidFromCashbox defaults true) silently bypassed
 * the cashbox. Reproduced a +1,455,000 balance error. Discovered 2026-08-15.
 * ──────────────────────────────────────────────────────────────────────────── */
await test("Problem 3 — transfer expenses reduce the cashbox", async () => {
  await login();
  const opening = 5000000;
  await api("POST", "/api/cashbox/opening-balance", { openingBalance: opening, openingDate: today(), currency: "SYP" });
  const expenses = [
    { category: "rent", description: "إيجار", amount: 800000, method: "transfer" },
    { category: "salaries", description: "راتب 3", amount: 280000, method: "transfer" },
    { category: "salaries", description: "راتب 5", amount: 375000, method: "transfer" },
  ];
  for (const e of expenses) await api("POST", "/api/expenses", { ...e, currency: "SYP", date: today() });
  const total = expenses.reduce((s, e) => s + e.amount, 0); // 1,455,000
  const cb = await api("GET", `/api/cashbox/balance/${today()}?currency=SYP`);
  const balance = typeof cb.data === "number" ? cb.data : cb.data?.balance ?? 0;
  ok("Cashbox reduced by all transfer expenses", balance === opening - total, `balance=${balance} expected=${opening - total}`);
  ok("No 1,455,000 residual", balance !== opening, `balance=${balance} (must not stay at ${opening})`);
});

/* ──────────────────────────────────────────────────────────────────────────── */
console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
if (failures.length) console.log("Failures:\n  - " + failures.join("\n  - "));
process.exit(failed === 0 ? 0 : 1);
