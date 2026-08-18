const API = "http://localhost:8080/api";
let token = "", passed = 0, failed = 0, failures = [];

async function api(path, opts = {}) {
  if (!token) { const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@erp.local", password: "Admin@12345" }) }); token = (await r.json()).accessToken; }
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts.headers } });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
function ok(n, c) { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}`); failures.push(n); } }
async function test(n, f) { console.log(`\n📋 ${n}`); try { await f(); } catch (e) { failed++; console.log(`  💥 ${e.message}`); failures.push(`${n}: ${e.message}`); } }

const SID = "e2b0e481-10c4-46c1-b4d5-c64bbd2ad25b";
const CID = "5b9f06a8-5e18-4c5a-b372-7eee0e23ea76";
const FID = "847ac9b2-5dff-4f92-b1f7-67829eb7fab8";
const CCOL = "1cb948a2-55c9-456d-873f-b75e12382323";
const RID = "2c2eea1e-15a6-4fca-8b0e-9963f5f777cd";

// === INVOICES ===
await test("فاتورة دخول", async () => {
  const { status, data } = await api("/invoices", { method: "POST", body: JSON.stringify({ type: "entry", date: "2026-08-12", partyId: SID, partyType: "supplier", currency: "SYP", lines: [{ fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 5, pricePerKg: 2000 }] }) });
  ok("POST → 201", status === 201 && data?.number?.startsWith("INV-"));
  ok("GET → 200", (await api(`/invoices/${data.id}`)).status === 200);
  ok("Cancel → 200", (await api(`/invoices/${data.id}/cancel`, { method: "POST" })).status === 200);
});

await test("فاتورة بيع", async () => {
  const { data: rolls } = await api("/inventory/rolls?limit=200");
  const sb = rolls.data.find(r => r.id === RID)?.remainingKg ?? 0;
  ok("Stock > 0", sb > 0);
  const { status, data } = await api("/invoices", { method: "POST", body: JSON.stringify({ type: "sale", date: "2026-08-12", partyId: CID, partyType: "customer", currency: "SYP", lines: [{ fabricId: FID, colorId: CCOL, rollId: RID, quantityKg: 3, pricePerKg: 5000 }] }) });
  ok("POST → 201 total=15000", status === 201 && data?.total === 15000);
  const { data: r2 } = await api("/inventory/rolls?limit=200");
  ok("Stock -3", r2.data.find(r => r.id === RID).remainingKg === sb - 3);
  await api(`/invoices/${data.id}/cancel`, { method: "POST" });
  const { data: r3 } = await api("/inventory/rolls?limit=200");
  ok("Stock restored", r3.data.find(r => r.id === RID).remainingKg === sb);
});

await test("Edge cases", async () => {
  ok("Bad UUID → 400", (await api("/invoices/bad")).status === 400);
  ok("Not-found → 404", (await api("/invoices/00000000-0000-0000-0000-000000000000")).status === 404);
  ok("List → 200", (await api("/invoices?limit=3")).status === 200);
});

// === RETURNS ===
await test("سجل المرتجعات", async () => {
  ok("List → 200", (await api("/returns?limit=3")).status === 200);
  ok("Filter entry", (await api("/returns?kind=entry&limit=3")).data?.data?.every(r => r.kind === "entry"));
  ok("Filter sale", (await api("/returns?kind=sale&limit=3")).data?.data?.every(r => r.kind === "sale"));
  ok("Limit 1000", (await api("/returns?limit=1000")).status === 200);
});
// === ACCOUNTING ===
await test("سندات", async () => {
  const { status, data } = await api("/receipts", { method: "POST", body: JSON.stringify({ kind: "receipt", date: "2026-08-12", partyId: CID, partyKind: "customer", amount: 5000, currency: "SYP", method: "cash" }) });
  ok("Receipt → 201", status === 201);
  ok("Cancel receipt → 200", (await api(`/receipts/${data.id}/cancel`, { method: "POST" })).status === 200);
  const p = await api("/payments", { method: "POST", body: JSON.stringify({ kind: "payment", date: "2026-08-12", partyId: SID, partyKind: "supplier", amount: 3000, currency: "SYP", method: "cash" }) });
  ok("Payment → 201", p.status === 201);
  ok("Cancel payment → 200", (await api(`/payments/${p.data.id}/cancel`, { method: "POST" })).status === 200);
});

await test("مصاريف", async () => {
  const { status, data } = await api("/expenses", { method: "POST", body: JSON.stringify({ date: "2026-08-12", category: "كهرباء", description: "فاتورة كهرباء", amount: 500, currency: "SYP", paidFromCashbox: true, method: "cash" }) });
  ok("Create → 201", status === 201);
  ok("Cancel → 200", (await api(`/expenses/${data.id}/cancel`, { method: "POST" })).status === 200);
});

await test("دفتر حركات + صندوق", async () => {
  ok("Ledger → 200", (await api("/ledger?limit=5")).status === 200);
  ok("Ledger asc → 200", (await api("/ledger?limit=5&sort=asc")).status === 200);
  ok("Cashbox state → 200", (await api("/cashbox/state")).status === 200);
  ok("Cashbox balance → 200", (await api("/cashbox/balance/2026-08-12")).status === 200);
  ok("Cashbox movements → 200", (await api("/cashbox/movements/2026-08-12?currency=SYP")).status === 200);
});

await test("كشف حساب", async () => {
  ok("Customer → 200", (await api(`/customers/${CID}/statement?currency=SYP`)).status === 200);
  ok("Supplier → 200", (await api(`/suppliers/${SID}/statement?currency=SYP`)).status === 200);
  ok("Bad UUID → 400", (await api("/customers/undefined/statement?currency=SYP")).status === 400);
  const syp = await api(`/customers/${CID}/statement?currency=SYP`);
  const usd = await api(`/customers/${CID}/statement?currency=USD`);
  ok("Multi-currency ok", syp.data && usd.data);
});

// === PRINT ===
await test("إرسال واستلام مطبعة", async () => {
  const { data: rolls } = await api("/inventory/rolls?limit=200");
  const sb = rolls.data.find(r => r.id === RID)?.remainingKg ?? 0;
  ok("Stock > 0", sb > 0);
  const { status, data } = await api("/printing/send", { method: "POST", body: JSON.stringify({ date: "2026-08-12", sourceRollId: RID, quantityKg: 5, pressName: "Test", currency: "SYP" }) });
  ok("Send → 201 PRT-*", status === 201 && data?.number?.startsWith("PRT-"));
  ok("In list", (await api("/printing")).data?.some(j => j.id === data.id));
  ok("In open", (await api("/printing/open")).data?.some(j => j.id === data.id));
  const { status: s2, data: rec } = await api("/printing/receive", { method: "POST", body: JSON.stringify({ jobId: data.id, date: "2026-08-12", receivedKg: 3, currency: "SYP" }) });
  ok("Receive → 200", s2 === 200 && rec?.status === "received");
  const { data: r2 } = await api("/inventory/rolls?limit=200");
  const ra = r2.data.find(r => r.id === RID);
  ok(`Stock deducted ${sb}→${ra?.remainingKg} expect ${sb-3}`, ra?.remainingKg === sb - 3);
  ok("Result roll created", r2.data.some(r => r.rollNo?.startsWith("PRT-") && r.remainingKg === 3));
});

// === ORDERS ===
await test("طلبات العملاء", async () => {
  const { status, data } = await api("/orders", { method: "POST", body: JSON.stringify({ customerNameSnapshot: "اختبار", date: "2026-08-12", currency: "SYP", items: [{ fabricName: "جاكار", colorName: "أحمر", requestedKg: 10 }] }) });
  ok("Create → 201 ORD-*", status === 201 && data?.code?.startsWith("ORD-"));
  ok("In list", (await api("/orders?limit=5")).data?.data?.some(o => o.id === data.id));
  ok("Update → 200", (await api(`/orders/${data.id}`, { method: "PUT", body: JSON.stringify({ notes: "test" }) })).status === 200);
  ok("Cancel → 200 cancelled", (await api(`/orders/${data.id}/cancel`, { method: "POST" })).data?.status === "cancelled");
  ok("Double cancel → 422", (await api(`/orders/${data.id}/cancel`, { method: "POST" })).status === 422);
});

// === REPORT ===
console.log(`\n${"=".repeat(50)}`);
console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log(`\n❌ FAILURES:`); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`\n🏁 ${failed === 0 ? '✅ GO — All tests passed' : '❌ NO-GO — Fix failures'}`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);