import pg from "pg";

const API = process.env.API_URL || "http://127.0.0.1:8080/api";
const TENANT = process.env.TENANT_ID || "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const EMAIL = process.env.SEED_EMAIL || "admin@erp.local";
const PASSWORD = process.env.SEED_PASSWORD || "admin123";
const log = (...a) => console.log(...a);

let token = "";
const c = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/erp" });

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Tenant-Id": TENANT },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
{
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantId: TENANT }) });
  const b = await r.json();
  if (!r.ok) throw new Error("login failed");
  token = b.accessToken;
}
await c.connect();

const fabric = new Map((await c.query("SELECT id,name FROM fabrics")).rows.map((r) => [r.id, r]));
const color = new Map((await c.query("SELECT id,name,fabric_id FROM colors")).rows.map((r) => [r.id, r]));
const roll = (await c.query("SELECT id,roll_no,color_id,initial_kg,remaining_kg,price_per_kg FROM rolls ORDER BY roll_no")).rows;
const party = new Map((await c.query("SELECT id,kind,name FROM parties")).rows.map((r) => [r.id, r]));

const customerIds = [...party.values()].filter((p) => p.kind === "customer").map((p) => p.id);
const supplierIds = [...party.values()].filter((p) => p.kind === "supplier").map((p) => p.id);

function lineFor(rr) {
  const col = color.get(rr.color_id);
  if (!col) return null;
  return { fabricId: col.fabric_id, colorId: rr.color_id, rollId: rr.id, pricePerKg: Number(rr.price_per_kg) };
}

// ---------- ENTRY invoice: all zero-stock rolls ----------
const zeroRolls = roll.filter((r) => Number(r.remaining_kg) === 0);
const bigEntryLines = zeroRolls.map((r) => { const l = lineFor(r); return l && { ...l, quantityKg: Number(r.initial_kg), pieces: 1 }; }).filter(Boolean);
let bigEntryId = null;
{
  const r = await api("POST", "/invoices", { type: "entry", date: "2026-08-10", partyId: supplierIds[0], partyType: "supplier", currency: "SYP", lines: bigEntryLines, discount: 0, tax: 0, notes: "TEST-ONLY فاتورة دخول متعددة الألوان/الأصباغ" });
  if (r.status !== 201) log("big entry ERR:", r.status, JSON.stringify(r.data));
  else { bigEntryId = r.data.id; log("big entry created:", r.data.number, "lines:", r.data.lines?.length); }
}

// ---------- SALE invoices ----------
const stockRolls = roll.filter((r) => Number(r.remaining_kg) > 0);
const salePlan = [
  { cust: 0, rows: [[0, 30], [1, 20]], paid: 0 },
  { cust: 1, rows: [[2, 25], [3, 30]], paid: 6000 },
  { cust: 2, rows: [[4, 20], [5, 25]], paid: 0 },
  { cust: 3, rows: [[6, 15]], paid: 8000 },
];
const saleIds = [];
for (const [si, plan] of salePlan.entries()) {
  const lines = plan.rows.map(([ri, qty]) => { const l = lineFor(stockRolls[ri]); return l && { ...l, quantityKg: qty, pieces: 1 }; }).filter(Boolean);
  const r = await api("POST", "/invoices", { type: "sale", date: `2026-08-1${si}`, partyId: customerIds[plan.cust], partyType: "customer", currency: "SYP", lines, discount: 0, tax: 0, paid: plan.paid, paymentMethod: plan.paid ? "cash" : undefined, notes: "TEST-ONLY فاتورة بيع" });
  if (r.status !== 201) log("sale ERR:", si, r.status, JSON.stringify(r.data));
  else { saleIds.push(r.data.id); log("sale invoice #" + (si + 1) + " created:", r.data.number); }
}

// ---------- SALE RETURN ----------
if (saleIds[0]) {
  const src = await api("GET", `/invoices/${saleIds[0]}`);
  const fl = src.data?.lines?.[0];
  if (fl) {
    const r = await api("POST", "/returns", { kind: "sale", date: "2026-08-20", partyId: customerIds[0], originalInvoiceId: saleIds[0], lines: [{ rollId: fl.rollId, quantityKg: 5, pieces: 1, pricePerKg: fl.pricePerKg }], reason: "defect", currency: "SYP", notesPrint: "TEST-ONLY مرتجع بيع" });
    if (r.status !== 201) log("return ERR:", r.status, JSON.stringify(r.data));
    else log("sale return created:", r.data.number);
  }
}

// ---------- VOUCHERS ----------
// receipts (from customers) x3
for (let i = 0; i < 3 && i < customerIds.length; i++) {
  const r = await api("POST", "/receipts", { kind: "receipt", date: `2026-08-${18 + i}`, partyId: customerIds[i], partyKind: "customer", amount: 3000 + i * 500, currency: "SYP", method: "cash", notesPrint: "TEST-ONLY سند قبض" });
  if (r.status !== 201) log("receipt ERR:", i, r.status, JSON.stringify(r.data));
  else log("receipt #" + (i + 1) + " created:", r.data.number);
}
// payments (to suppliers) x2
for (let i = 0; i < 2 && i < supplierIds.length; i++) {
  const r = await api("POST", "/payments", { kind: "payment", date: `2026-08-${18 + i}`, partyId: supplierIds[i], partyKind: "supplier", amount: 2000 + i * 400, currency: "SYP", method: "transfer", notesPrint: "TEST-ONLY سند صرف" });
  if (r.status !== 201) log("payment ERR:", i, r.status, JSON.stringify(r.data));
  else log("payment #" + (i + 1) + " created:", r.data.number);
}

// ---------- ORDERS ----------
const orderPlan = [
  { cust: 0, items: [[5, 15], [1, 20]] },
  { cust: 1, items: [[3, 12]] },
  { cust: 2, items: [[6, 10], [2, 10]] },
];
for (const [oi, plan] of orderPlan.entries()) {
  const cust = customerIds[plan.cust];
  const custName = party.get(cust)?.name || "(اختبار) عميل";
  const items = plan.items.map(([ri, kg]) => {
    const rr = stockRolls[ri];
    const col = color.get(rr.color_id);
    const fab = fabric.get(col.fabric_id);
    return { fabricName: fab?.name || "قماش", colorName: col?.name || "لون", requestedKg: kg, pieces: 1, rollId: rr.id };
  });
  const r = await api("POST", "/orders", { customerId: cust, customerNameSnapshot: custName, date: "2026-08-15", currency: "SYP", notes: "TEST-ONLY طلب", items });
  if (r.status !== 201) log("order ERR:", oi, r.status, JSON.stringify(r.data));
  else log("order #" + (oi + 1) + " created:", r.data.code);
}

// ---------- Final DB verification ----------
const checks = ["invoices", "invoice_lines", "returns", "return_lines", "vouchers", "orders", "order_items", "stock_movements", "ledger_entries", "parties", "fabrics", "rolls"];
const summary = {};
for (const t of checks) {
  const r = await c.query(`SELECT count(*) AS n FROM "${t}"`);
  summary[t] = r.rows[0].n;
}
log("\nFINAL DB COUNTS:", JSON.stringify(summary));
await c.end();
process.exit(0);