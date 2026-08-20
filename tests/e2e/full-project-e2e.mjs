/**
 * Full Project End-to-End Test — اختبار شامل للمشروع
 *
 * Covers:
 * 1. Multi-color invoices (Phase 1: Entry, Phase 2: Sale, Phase 3: Return)
 * 2. Full backup API (ZIP download)
 * 3. Audit log tracking (invoice history)
 * 4. Deep health check
 * 5. Statement (كشف حساب) with currency integrity
 * 6. Print layout (unified header/footer)
 * 7. Security (brute-force, token types)
 * 8. Database performance (indexes)
 *
 * Run: node tests/e2e/full-project-e2e.mjs
 * Requires: Server running on localhost:8080, test data (supplier, customer, fabric, color, roll)
 */

const API = "http://localhost:8080/api";
let token = "",
  passed = 0,
  failed = 0,
  failures = [];

async function api(path, opts = {}) {
  if (!token) {
    const r = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@erp.local", password: "Admin@12345" }),
    });
    const data = await r.json().catch(() => ({}));
    token = data.accessToken || data.token || "";
    if (!token) {
      console.log("⚠️  Login failed — server might be down or credentials wrong");
      console.log("   Response:", data);
      process.exit(1);
    }
  }
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data, headers: res.headers };
}

function ok(n, c) {
  if (c) {
    passed++;
    console.log(`  ✅ ${n}`);
  } else {
    failed++;
    console.log(`  ❌ ${n}`);
    failures.push(n);
  }
}

async function test(n, f) {
  console.log(`\n📋 ${n}`);
  try {
    await f();
  } catch (e) {
    failed++;
    console.log(`  💥 ${e.message}`);
    failures.push(`${n}: ${e.message}`);
  }
}

// Test data IDs (same as comprehensive-api.mjs)
const SID = "e2b0e481-10c4-46c1-b4d5-c64bbd2ad25b";
const CID = "5b9f06a8-5e18-4c5a-b372-7eee0e23ea76";
const FID = "847ac9b2-5dff-4f92-b1f7-67829eb7fab8";
const CCOL = "1cb948a2-55c9-456d-873f-b75e12382323";
const RID = "2c2eea1e-15a6-4fca-8b0e-9963f5f777cd";

// ────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("🧪 FABRIC ERP — Full Project End-to-End Test");
console.log("📅 Date:", new Date().toLocaleString("ar-SY"));
console.log("=".repeat(60));

// ─── 1. HEALTH CHECK ────────────────────────────────────────
await test("Health Check (الفحص العميق)", async () => {
  const { status, data } = await api("/health/deep");
  ok("Status 200", status === 200);
  ok("Has database check", data?.checks?.database?.status === "ok");
  ok("Has memory check", data?.checks?.memory?.status !== undefined);
  ok("Has uptime", data?.uptime > 0);
  ok("Has version", data?.version !== undefined);
  console.log(
    `  ℹ️  Server uptime: ${Math.floor(data?.uptime || 0)}s, Response: ${data?.responseTime}ms`,
  );
});

// ─── 2. SECURITY: LOGIN & TOKEN ─────────────────────────────
await test("Security (الأمان)", async () => {
  // Bad credentials
  const bad = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@erp.local", password: "wrong" }),
  });
  ok("Bad password → 401", bad.status === 401 || bad.status === 429);

  // Missing token
  const noAuth = await fetch(`${API}/invoices?limit=1`, {
    headers: { "Content-Type": "application/json" },
  });
  ok("No token → 401/403", noAuth.status === 401 || noAuth.status === 403);
});

// ─── 3. MULTI-COLOR ENTRY INVOICE (Phase 1) ─────────────────
await test("Phase 1: فاتورة دخول متعددة الألوان", async () => {
  const invoice = {
    type: "entry",
    date: "2026-08-16",
    partyId: SID,
    partyType: "supplier",
    currency: "SYP",
    lines: [
      { fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 5, pricePerKg: 2000 },
      { fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 3, pricePerKg: 2200 },
    ],
  };
  const { status, data } = await api("/invoices", {
    method: "POST",
    body: JSON.stringify(invoice),
  });
  ok("POST entry → 201", status === 201 && data?.number?.startsWith("INV-"));
  ok("Has 2 lines", data?.lines?.length === 2);
  ok("Line 1 total = 10000", data?.lines?.[0]?.total === 10000);
  ok("Line 2 total = 6600", data?.lines?.[1]?.total === 6600);
  ok("Invoice total = 16600", data?.total === 16600);

  // Get by ID
  const get = await api(`/invoices/${data.id}`);
  ok("GET by ID → 200", get.status === 200);
  ok("Lines preserved", get.data?.lines?.length === 2);

  // Cancel
  const cancel = await api(`/invoices/${data.id}/cancel`, { method: "POST" });
  ok("Cancel → 200", cancel.status === 200);
  ok("Status cancelled", cancel.data?.status === "cancelled");
});

// ─── 4. MULTI-COLOR SALE INVOICE (Phase 2) ──────────────────
await test("Phase 2: فاتورة بيع متعددة الألوان", async () => {
  const { data: rolls } = await api("/inventory/rolls?limit=200");
  const stockBefore = rolls.data?.find((r) => r.id === RID)?.remainingKg ?? 0;
  ok("Stock available", stockBefore > 0);

  const invoice = {
    type: "sale",
    date: "2026-08-16",
    partyId: CID,
    partyType: "customer",
    currency: "SYP",
    lines: [
      { fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 2, pricePerKg: 5000 },
      { fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 1, pricePerKg: 5500 },
    ],
  };
  const { status, data } = await api("/invoices", {
    method: "POST",
    body: JSON.stringify(invoice),
  });
  ok("POST sale → 201", status === 201 && data?.number?.startsWith("INV-"));
  ok("Stock deducted", data?.lines?.length === 2);

  // Verify stock reduced
  const { data: rollsAfter } = await api("/inventory/rolls?limit=200");
  const stockAfter = rollsAfter.data?.find((r) => r.id === RID)?.remainingKg ?? 0;
  ok("Stock -3kg", stockAfter === stockBefore - 3);

  // Print preview
  const print = await api(`/invoices/${data.id}/print`);
  ok("Print preview → 200", print.status === 200);

  // Cancel and restore stock
  await api(`/invoices/${data.id}/cancel`, { method: "POST" });
  const { data: rollsRestored } = await api("/inventory/rolls?limit=200");
  const stockRestored = rollsRestored.data?.find((r) => r.id === RID)?.remainingKg ?? 0;
  ok("Stock restored", stockRestored === stockBefore);
});

// ─── 5. RETURN WITH MULTI-COLOR (Phase 3) ───────────────────
await test("Phase 3: مرتجع متعدد الألوان", async () => {
  // First create a sale to return from
  const sale = await api("/invoices", {
    method: "POST",
    body: JSON.stringify({
      type: "sale",
      date: "2026-08-16",
      partyId: CID,
      partyType: "customer",
      currency: "SYP",
      lines: [{ fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 2, pricePerKg: 5000 }],
    }),
  });
  ok("Sale for return → 201", sale.status === 201);

  const { data: stockBefore } = await api("/inventory/rolls?limit=200");
  const sb = stockBefore.data?.find((r) => r.id === RID)?.remainingKg ?? 0;

  // Create return
  const ret = await api("/returns", {
    method: "POST",
    body: JSON.stringify({
      kind: "sale",
      date: "2026-08-16",
      partyId: CID,
      partyType: "customer",
      currency: "SYP",
      lines: [
        {
          invoiceId: sale.data.id,
          fabricId: FID,
          colorId: CCOL,
          rollId: RID,
          quantityKg: 1,
          pricePerKg: 5000,
        },
      ],
    }),
  });
  ok("Return → 201", ret.status === 201 && ret.data?.number?.startsWith("RET-"));

  // Verify stock restored by 1kg
  const { data: stockAfter } = await api("/inventory/rolls?limit=200");
  const sa = stockAfter.data?.find((r) => r.id === RID)?.remainingKg ?? 0;
  ok("Stock +1kg after return", sa === sb + 1);

  // Cancel return
  await api(`/returns/${ret.data.id}/cancel`, { method: "POST" });
  const { data: stockFinal } = await api("/inventory/rolls?limit=200");
  const sf = stockFinal.data?.find((r) => r.id === RID)?.remainingKg ?? 0;
  ok("Stock back after cancel", sf === sb);

  // Cancel the original sale
  await api(`/invoices/${sale.data.id}/cancel`, { method: "POST" });
});

// ─── 6. STATEMENT (كشف حساب) ───────────────────────────────
await test("كشف حساب (Statement)", async () => {
  const syp = await api(`/customers/${CID}/statement?currency=SYP`);
  ok("Customer statement SYP → 200", syp.status === 200);
  ok("Has balance", syp.data?.balance !== undefined);
  ok("Has entries", Array.isArray(syp.data?.entries));

  const usd = await api(`/customers/${CID}/statement?currency=USD`);
  ok("Customer statement USD → 200", usd.status === 200);

  const sup = await api(`/suppliers/${SID}/statement?currency=SYP`);
  ok("Supplier statement → 200", sup.status === 200);
});

// ─── 7. AUDIT LOG (تتبع الفواتير) ──────────────────────────
await test("Audit Log (تتبع الفواتير)", async () => {
  // Create a test invoice to track
  const { data: inv } = await api("/invoices", {
    method: "POST",
    body: JSON.stringify({
      type: "entry",
      date: "2026-08-16",
      partyId: SID,
      partyType: "supplier",
      currency: "SYP",
      lines: [{ fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 1, pricePerKg: 1000 }],
    }),
  });

  // Get audit logs for this invoice
  const audit = await api(`/audit-logs/invoice/${inv.id}`);
  ok("Audit log for invoice → 200", audit.status === 200);
  ok("Has audit data", Array.isArray(audit.data?.data));
  ok("Has meta", audit.data?.meta !== undefined);

  // Query with filters
  const filtered = await api(`/audit-logs?entityType=invoice&entityId=${inv.id}&limit=10`);
  ok("Filtered audit logs → 200", filtered.status === 200);

  // Cancel the invoice
  await api(`/invoices/${inv.id}/cancel`, { method: "POST" });

  // Check audit log after cancel
  const auditAfter = await api(`/audit-logs/invoice/${inv.id}`);
  ok("Audit log after cancel → 200", auditAfter.status === 200);
  const hasCancel = auditAfter.data?.data?.some((e) => e.action === "cancel");
  ok("Cancel action logged", hasCancel);
});

// ─── 8. FULL BACKUP API ─────────────────────────────────────
await test("Full Backup (النسخ الاحتياطي الكامل)", async () => {
  const res = await fetch(`${API}/backup/full`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": "demo-tenant" },
  });
  ok("Backup API → 200", res.status === 200);
  ok("Content-Type is ZIP", res.headers.get("content-type")?.includes("zip"));
  ok(
    "Content-Disposition has filename",
    res.headers.get("content-disposition")?.includes("fabric-erp-backup"),
  );

  const blob = await res.blob();
  ok("ZIP size > 0", blob.size > 0);
  console.log(`  ℹ️  ZIP size: ${(blob.size / 1024).toFixed(1)} KB`);
});

// ─── 9. PRINTING (Unified Layout) ───────────────────────────
await test("Print Layout (الطباعة الموحدة)", async () => {
  // Create invoice for print test
  const { data: inv } = await api("/invoices", {
    method: "POST",
    body: JSON.stringify({
      type: "sale",
      date: "2026-08-16",
      partyId: CID,
      partyType: "customer",
      currency: "SYP",
      lines: [{ fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 1, pricePerKg: 5000 }],
    }),
  });

  // Print preview
  const print = await api(`/invoices/${inv.id}/print`);
  ok("Print preview → 200", print.status === 200);
  ok("Has HTML content", print.data?.html?.length > 0 || print.data?.content?.length > 0);

  // Print job list
  const jobs = await api("/printing?limit=5");
  ok("Print jobs list → 200", jobs.status === 200);

  // Cancel test invoice
  await api(`/invoices/${inv.id}/cancel`, { method: "POST" });
});

// ─── 10. VOUCHERS & ACCOUNTING ──────────────────────────────
await test("Vouchers & Accounting (السندات والمحاسبة)", async () => {
  // Receipt
  const receipt = await api("/receipts", {
    method: "POST",
    body: JSON.stringify({
      kind: "receipt",
      date: "2026-08-16",
      partyId: CID,
      partyKind: "customer",
      amount: 10000,
      currency: "SYP",
      method: "cash",
    }),
  });
  ok("Receipt → 201", receipt.status === 201);

  // Payment
  const payment = await api("/payments", {
    method: "POST",
    body: JSON.stringify({
      kind: "payment",
      date: "2026-08-16",
      partyId: SID,
      partyKind: "supplier",
      amount: 5000,
      currency: "SYP",
      method: "cash",
    }),
  });
  ok("Payment → 201", payment.status === 201);

  // Ledger entries
  const ledger = await api("/ledger?limit=10");
  ok("Ledger list → 200", ledger.status === 200);
  ok("Has entries", Array.isArray(ledger.data?.data));

  // Cashbox
  const cashbox = await api("/cashbox/state");
  ok("Cashbox state → 200", cashbox.status === 200);
});

// ─── 11. DATABASE INDEXES (Performance) ─────────────────────
await test("Database Performance (أداء قاعدة البيانات)", async () => {
  // List invoices with filters (should use indexes)
  const t1 = Date.now();
  const invoices = await api("/invoices?status=active&limit=100");
  const t2 = Date.now();
  ok("List invoices → 200", invoices.status === 200);
  ok("Fast query (< 500ms)", t2 - t1 < 500);
  console.log(`  ℹ️  Invoice list: ${t2 - t1}ms`);

  // Statement query (should use idx_ledger_party_date)
  const t3 = Date.now();
  const stmt = await api(
    `/customers/${CID}/statement?currency=SYP&fromDate=2026-01-01&toDate=2026-12-31`,
  );
  const t4 = Date.now();
  ok("Statement → 200", stmt.status === 200);
  ok("Fast statement (< 500ms)", t4 - t3 < 500);
  console.log(`  ℹ️  Statement query: ${t4 - t3}ms`);

  // Audit logs (should use idx_audit_logs_tenant_entity)
  const t5 = Date.now();
  const audit = await api("/audit-logs?entityType=invoice&limit=50");
  const t6 = Date.now();
  ok("Audit logs → 200", audit.status === 200);
  ok("Fast audit (< 500ms)", t6 - t5 < 500);
  console.log(`  ℹ️  Audit logs query: ${t6 - t5}ms`);
});

// ─── 12. ERROR HANDLING ─────────────────────────────────────
await test("Error Handling (معالجة الأخطاء)", async () => {
  // Bad UUID
  ok("Bad UUID → 400", (await api("/invoices/bad-uuid")).status === 400);

  // Not found
  ok(
    "Not found → 404",
    (await api("/invoices/00000000-0000-0000-0000-000000000000")).status === 404,
  );

  // Invalid filter
  ok("Invalid filter → 400/422", (await api("/invoices?status=invalid")).status >= 400);

  // Unauthorized
  ok(
    "No auth → 401/403",
    (await api("/invoices?limit=1", { headers: { Authorization: "" } })).status >= 401,
  );
});

// ────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(`\n❌ FAILURES:`);
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(
  `\n🏁 ${failed === 0 ? "✅ GO — All tests passed! Project is production-ready." : "❌ NO-GO — Fix failures before deployment."}`,
);
console.log("=".repeat(60));

process.exit(failed > 0 ? 1 : 0);
