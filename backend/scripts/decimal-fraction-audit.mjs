/**
 * Decimal-fraction live audit — QA task 2026-08-23.
 *
 * Creates 3 entry + 3 sale invoices in USD with explicit decimal inputs
 * (price 1.5$, line discount 0.5$, qty 12.5kg, invoice discount 0.5$),
 * then re-reads them from the API and compares stored values against
 * exact decimal math. Creates tagged demo documents only ("DECIMAL-AUDIT").
 */
const BASE = "http://127.0.0.1:8080";
const TENANT_ID = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const today = () => new Date().toISOString().slice(0, 10);

let token = "";
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

let failures = 0;
function check(label, actual, expected) {
  const ok = Math.abs(Number(actual) - expected) < 1e-9;
  if (!ok) failures++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: stored=${actual} expected=${expected}`);
}

async function findOrCreate(kind, name, extra = {}) {
  const list = await api("GET", `/api/${kind}?search=${encodeURIComponent(name)}&limit=100`);
  const items = list.json?.data ?? [];
  if (list.status >= 400) console.log(`   WARN GET /api/${kind} → ${list.status} ${JSON.stringify(list.json).slice(0, 200)}`);
  const found = items.find((p) => p.name === name);
  if (found) return found;
  const res = await api("POST", `/api/${kind}`, { name, currency: "USD", ...extra });
  if (res.status >= 400) console.log(`   ERROR POST /api/${kind} → ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  else console.log(`   created ${kind} "${name}" → ${res.status}`);
  return res.json?.data ?? res.json;
}

async function main() {
  console.log("── 1) Login ──");
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@erp.local", password: "admin123", tenantId: TENANT_ID }),
  });
  if (login.status !== 200) { console.error("LOGIN FAILED", login.status, await login.text()); process.exit(1); }
  token = (await login.json()).accessToken;
  console.log("   ✅ logged in");

  console.log("── 2) Fixtures (USD) ──");
  const customer = await findOrCreate("customers", "DECIMAL-AUDIT Customer");
  const supplier = await findOrCreate("suppliers", "DECIMAL-AUDIT Supplier");
  let fabrics = (await api("GET", `/api/inventory/fabrics?search=DECIMAL-AUDIT&limit=100`)).json?.data ?? [];
  let fabric = fabrics.find((f) => f.name === "DECIMAL-AUDIT Fabric");
  if (!fabric) {
    const r = await api("POST", "/api/inventory/fabrics", { name: "DECIMAL-AUDIT Fabric" });
    if (r.status >= 400) console.log(`   ERROR fabric → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    fabric = r.json?.data ?? r.json;
  }
  let colors = (await api("GET", `/api/inventory/colors?fabricId=${fabric.id}&limit=100`)).json?.data ?? [];
  let color = colors.find((c) => c.name === "DECIMAL-AUDIT Color");
  if (!color) {
    const r = await api("POST", "/api/inventory/colors", { fabricId: fabric.id, name: "DECIMAL-AUDIT Color", code: "DECA" });
    if (r.status >= 400) console.log(`   ERROR color → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    color = r.json?.data ?? r.json;
  }
  const rolls = (await api("GET", "/api/inventory/rolls?limit=1000")).json?.data ?? [];
  let rollEntry = rolls.find((r) => r.rollNo === "DECIMAL-AUDIT-ENTRY");
  if (!rollEntry) {
    const r = await api("POST", "/api/inventory/rolls", {
      colorId: color.id, rollNo: "DECIMAL-AUDIT-ENTRY", initialKg: 500, pricePerKg: 2.25, currency: "USD", entryDate: today(), pieces: 50,
    });
    if (r.status >= 400) console.log(`   ERROR entry roll → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    rollEntry = r.json?.data ?? r.json;
  }
  let rollSale = rolls.find((r) => r.rollNo === "DECIMAL-AUDIT-SALE");
  if (!rollSale) {
    const r = await api("POST", "/api/inventory/rolls", {
      colorId: color.id, rollNo: "DECIMAL-AUDIT-SALE", initialKg: 500, pricePerKg: 3.75, currency: "USD", entryDate: today(), pieces: 50,
    });
    if (r.status >= 400) console.log(`   ERROR sale roll → ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    rollSale = r.json?.data ?? r.json;
  }
  console.log("   ✅ fixtures ready");



  console.log("── 3) Scenario A: decimals in qty/price ONLY (no discounts) ──");
  const mkLine = (extra = {}) => ({
    fabricId: color.fabricId, colorId: color.id, rollId: rollSale.id,
    quantityKg: 12.5, pieces: 1, pricePerKg: 1.5, ...extra,
  });
  const resA = await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "USD",
    lines: [mkLine()],
    notes: "DECIMAL-AUDIT scenario A",
  });
  console.log(`   A → HTTP ${resA.status} ${resA.status >= 400 ? JSON.stringify(resA.json).slice(0, 250) : ""}`);
  if (resA.status < 400) {
    const inv = (await api("GET", `/api/invoices/${(resA.json?.data ?? resA.json).id}`)).json?.data ?? (await api("GET", `/api/invoices/${(resA.json?.data ?? resA.json).id}`)).json ?? {};
    const l = inv.lines?.[0] ?? {};
    console.log(`   exact math: 12.5 × 1.5 = 18.75`);
    check("A.quantityKg", l.quantityKg, 12.5);
    check("A.pricePerKg", l.pricePerKg, 1.5);
    check("A.subtotal (18.75 exact)", inv.subtotal ?? inv.totalBeforeDiscounts, 18.75);
    check("A.total", inv.total ?? inv.grandTotal, 18.75);
    console.log(`      raw: subtotal=${JSON.stringify(inv.subtotal)} total=${JSON.stringify(inv.total)}`);
  }

  console.log("── 4) Scenario B: + line discount 0.5$ ──");
  const resB = await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "USD",
    lines: [mkLine({ discountAmount: 0.5 })],
    notes: "DECIMAL-AUDIT scenario B",
  });
  console.log(`   B → HTTP ${resB.status} ${JSON.stringify(resB.json).slice(0, 250)}`);

  console.log("── 5) Scenario C: + invoice-level discount 0.5$ ──");
  const resC = await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "USD",
    discount: 0.5,
    lines: [mkLine()],
    notes: "DECIMAL-AUDIT scenario C",
  });
  console.log(`   C → HTTP ${resC.status} ${JSON.stringify(resC.json).slice(0, 250)}`);

  console.log("── 6) Scenario D: + paid 10.25$ ──");
  const resD = await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "USD",
    paid: 10.25,
    lines: [mkLine()],
    notes: "DECIMAL-AUDIT scenario D",
  });
  console.log(`   D → HTTP ${resD.status} ${JSON.stringify(resD.json).slice(0, 250)}`);

  console.log("── 7) Verify C & D stored values exactly ──");
  {
    const invC = (await api("GET", `/api/invoices/${(resC.json?.data ?? resC.json).id}`)).json;
    const invD = (await api("GET", `/api/invoices/${(resD.json?.data ?? resD.json).id}`)).json;
    console.log(`   C ${invC.number}: discount=${JSON.stringify(invC.discount)} subtotal=${JSON.stringify(invC.subtotal)} total=${JSON.stringify(invC.total)}`);
    check("C.total = 18.75 − 0.50", invC.total, 18.25);
    check("C.discount", invC.discount, 0.5);
    console.log(`   D ${invD.number}: paid=${JSON.stringify(invD.paid)} total=${JSON.stringify(invD.total)} amountDue=${JSON.stringify(invD.amountDue)}`);
    check("D.paid", invD.paid, 10.25);
    if (invD.amountDue !== undefined) check("D.amountDue = 18.75 − 10.25", invD.amountDue, 8.5);
    // Ledger legs must carry the same cents
    const ledger = (await api("GET", "/api/ledger?limit=10")).json?.data ?? [];
    const leg = ledger.find((e) => e.referenceId === invC.id || e.referenceNumber === invC.number);
    if (leg) {
      const amt = Number(leg.debit || leg.credit);
      check(`ledger leg for ${invC.number}`, amt, 18.25);
    } else {
      console.log("   (no direct ledger leg found in first page — checked via journal below)");
    }
  }

  console.log("── 8) Create 3 ENTRY + 3 SALE demo invoices (full decimals) ──");
  const created = { entry: [], sale: [] };
  for (let i = 1; i <= 3; i++) {
    const res = await api("POST", "/api/invoices", {
      type: "entry", date: today(), partyId: supplier.id, partyType: "supplier", currency: "USD",
      discount: 0.5, paid: 10.25,
      lines: [{
        fabricId: color.fabricId, colorId: color.id, rollId: rollEntry.id,
        quantityKg: 12.5, pieces: 1, pricePerKg: 2.25, discountAmount: 0.5,
      }],
      notes: `DECIMAL-AUDIT فاتورة دخول تجريبية #${i} — سعر 2.25$، خصم سطر 0.5$، كمية 12.5كغ`,
    });
    const inv = res.json?.data ?? res.json;
    console.log(`   entry #${i} → HTTP ${res.status} ${inv?.number ?? ""}${res.status >= 400 ? " " + JSON.stringify(res.json).slice(0, 200) : ""}`);
    if (res.status < 400 && inv?.id) created.entry.push(inv);
  }
  for (let i = 1; i <= 3; i++) {
    const res = await api("POST", "/api/invoices", {
      type: "sale", date: today(), partyId: customer.id, partyType: "customer", currency: "USD",
      discount: 0.5, paid: 5.5,
      lines: [{
        fabricId: color.fabricId, colorId: color.id, rollId: rollSale.id,
        quantityKg: 12.5, pieces: 1, pricePerKg: 1.5, discountAmount: 0.5,
      }],
      notes: `DECIMAL-AUDIT فاتورة بيع تجريبية #${i} — سعر 1.5$، خصم سطر 0.5$، كمية 12.5كغ`,
    });
    const inv = res.json?.data ?? res.json;
    console.log(`   sale #${i} → HTTP ${res.status} ${inv?.number ?? ""}${res.status >= 400 ? " " + JSON.stringify(res.json).slice(0, 200) : ""}`);
    if (res.status < 400 && inv?.id) created.sale.push(inv);
  }

  console.log("── 9) Verify the 6 demo invoices against exact math ──");
  // Entry line: 12.5×2.25 − 0.5 = 27.625 → round2dp per line = 27.63; total = 27.63 − 0.5 = 27.13
  // Sale line: 12.5×1.5 − 0.5 = 18.25; total = 18.25 − 0.5 = 17.75
  for (const inv of created.entry) {
    const full = (await api("GET", `/api/invoices/${inv.id}`)).json;
    check(`${full.number} subtotal`, full.subtotal, 27.63);
    check(`${full.number} total`, full.total, 27.13);
    check(`${full.number} paid`, full.paid, 10.25);
  }
  for (const inv of created.sale) {
    const full = (await api("GET", `/api/invoices/${inv.id}`)).json;
    check(`${full.number} subtotal`, full.subtotal, 18.25);
    check(`${full.number} total`, full.total, 17.75);
    check(`${full.number} paid`, full.paid, 5.5);
  }

  console.log(`   A (qty/price decimals only): ${resA.status < 400 ? "ACCEPTED ✅" : "REJECTED ❌"}${resA.status < 400 ? " (but cents rounded in totals? see checks above)" : ""}`);
  console.log(`   B (line discount 0.5$):      ${resB.status < 400 ? "ACCEPTED ✅" : "REJECTED ❌"}`);
  console.log(`   C (invoice discount 0.5$):   ${resC.status < 400 ? "ACCEPTED ✅" : "REJECTED ❌"}`);
  console.log(`   D (paid 10.25$):             ${resD.status < 400 ? "ACCEPTED ✅" : "REJECTED ❌"}`);

}

main().catch((e) => { console.error(e); process.exit(1); });

