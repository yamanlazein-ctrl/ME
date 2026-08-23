// ── Pre-handoff field test: 5 entry + 5 sale invoices, per-invoice ledger audit ──
const TENANT = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const BASE = "http://127.0.0.1:8080";
const TODAY = new Date().toISOString().slice(0, 10);

const lr = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@erp.local", password: "admin123", tenantId: TENANT }),
});
const { accessToken } = await lr.json();
if (!accessToken) throw new Error("login failed");
const H = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "X-Tenant-Id": TENANT };

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const results = [];
let allOk = true;
function check(label, cond, detail = "") {
  if (!cond) allOk = false;
  results.push(`${cond ? "✓" : "✗ FAIL"} ${label}${detail ? " — " + detail : ""}`);
}

// ── fixtures ──
const suppliers = [];
for (const name of ["مورد دمشق الصناعي", "شركة حلب للنسيج", "مورد حمص المركزي"]) {
  const s = await api("POST", "/api/suppliers", { name, phone: "099900000" + suppliers.length });
  suppliers.push(s.id ?? s.data?.id);
}
const customers = [];
for (const name of ["عميل اللاذقية التجاري", "معرض طرابلس للأقمشة"]) {
  const cu = await api("POST", "/api/customers", { name, phone: "098800000" + customers.length });
  customers.push(cu.id ?? cu.data?.id);
}
suppliers.push("004bdbfd-442c-4983-9152-3c7df026dd80");           // موجود
suppliers.push("c8d5f5fd-3691-4390-a8cc-2bcd5c1a2a7d");           // موجود
customers.push("4bb2b845-f757-4da3-b751-c8a457c8ef06");            // موجود

// rolls: [id, colorId, fabricId] — 4 rolls over 3 fabrics / 4 colors
const R = [
  ["2ac33c14-f61e-4272-84a9-8a413a5a514b", "4094d1d2-bc97-4839-bfeb-1033af8131c4", "bc002496-869a-428c-acd2-17fc0273bb43"],
  ["8812d94a-b57b-4ce4-af48-0df865d92a1a", null, "c96a613a-8bb6-428a-b30e-bf950253061a"],
  ["fa769a38-c3cc-4511-ae0c-939add741738", null, "ef5dfe8b-7d40-4cac-a392-887a307c511a"],
  ["58aaf137-f6b7-43e4-9d86-c4d67800a75f", null, "ef5dfe8b-7d40-4cac-a392-887a307c511a"],
];
// resolve missing colorIds
{
  const inv = await api("GET", "/api/invoices?limit=1"); // warm
}
const rollsFull = [];
for (const [id, colorId, fabricId] of R) {
  if (colorId) { rollsFull.push({ id, colorId, fabricId }); continue; }
  const q = await import("node:child_process");
}

// pull roll→color→fabric straight from DB for correctness
import pg from "pg";
const dbc = new pg.Client("postgresql://postgres:postgres@localhost:5432/erp");
await dbc.connect();
const rollRows = await dbc.query(
  `select r.id, r.color_id "colorId", c.fabric_id "fabricId", r.price_per_kg::text "costKg"
   from rolls r join colors c on r.color_id = c.id order by r.created_at desc limit 4`);
await dbc.end();
const rolls = rollRows.rows;

// ── ledger verification helper ──
async function verifyBatch(invNumber, expect) {
  const refs = [invNumber, `PAY-${invNumber}`, `RCP-${invNumber}`];
  const q = `
    select type, debit::text dr, credit::text cr, currency,
           (party_id is not null) has_party
    from ledger_entries
    where reference_number = any($1) and status = 'active'`;
  const vals = [refs];
  const { rows } = await (() => { const p = new pg.Client("postgresql://postgres:postgres@localhost:5432/erp"); return p.connect().then(async () => { const r = await p.query(q, vals); await p.end(); return r; }); })();
  let sum = 0; const currencies = new Set(); const byType = {};
  for (const x of rows) {
    sum += Number(x.dr) - Number(x.cr);
    currencies.add(x.currency);
    byType[x.type] = byType[x.type] || [];
    byType[x.type].push({ dr: Number(x.dr), cr: Number(x.cr), party: x.has_party });
  }
  check(`[${invNumber}] Σ(مدين−دائن)=0`, sum === 0, `Σ=${sum}`);
  check(`[${invNumber}] عملة موحدة`, currencies.size === 1, [...currencies].join(","));
  for (const [type, assertion] of Object.entries(expect)) {
    const legs = byType[type] || [];
    check(`[${invNumber}] قيد ${type}`, legs.length > 0 && assertion(legs[0]), JSON.stringify(legs));
  }
  return sum;
}

// ════════ 5 ENTRY INVOICES ════════
const entrySpecs = [
  { sup: suppliers[0], lines: [{ r: 0, kg: 12.5, pcs: 3, price: 8500000, disc: 250000 }], invDisc: 500000, tax: 1250000, ship: 400000, paid: 20000000 },
  { sup: suppliers[1], lines: [{ r: 1, kg: 40, pcs: 10, price: 45000, disc: 50000 }], invDisc: 100000, tax: 0, ship: 75000, paid: 1500000 },
  { sup: suppliers[2], lines: [{ r: 2, kg: 18.25, pcs: 5, price: 1200000, disc: 0 }, { r: 3, kg: 7.75, pcs: 2, price: 950000, disc: 175000 }], invDisc: 250000, tax: 350000, ship: 0, paid: 0 },
  { sup: suppliers[3], lines: [{ r: 0, kg: 5, pcs: 1, price: 9200000, disc: 2000000 }], invDisc: 0, tax: 600000, ship: 250000, paid: 40000000 },
  { sup: suppliers[4], lines: [{ r: 1, kg: 33.33, pcs: 8, price: 52000, disc: 66000 }, { r: 2, kg: 9.5, pcs: 4, price: 61000, disc: 15500 }], invDisc: 12345, tax: 98765, ship: 43210, paid: 1500000 },
];

console.log("\n════════ فواتير الدخول ════════");
for (let i = 0; i < entrySpecs.length; i++) {
  const s = entrySpecs[i];
  const body = {
    type: "entry", date: TODAY, partyId: s.sup, partyType: "supplier",
    currency: "SYP", discount: s.invDisc, tax: s.tax, shipping: s.ship,
    paid: s.paid, ...(s.paid > 0 ? { paymentMethod: "cash" } : {}),
    lines: s.lines.map((l) => ({
      fabricId: rolls[l.r].fabricId, colorId: rolls[l.r].colorId, rollId: rolls[l.r].id,
      quantityKg: l.kg, pieces: l.pcs, pricePerKg: l.price, discountAmount: l.disc,
    })),
  };
  // independent expected math (canonical formulas)
  const expSubtotal = body.lines.reduce((t, l) => t + Math.max(0, Math.round(l.quantityKg * l.pricePerKg - l.discountAmount)), 0);
  const expTotal = expSubtotal - s.invDisc + s.tax + s.ship;
  const inv = await api("POST", "/api/invoices", body);
  check(`دخول#${i + 1} رقم مرجعي ENT`, /^ENT-\d{4}-\d{4}$/.test(inv.number), inv.number);
  check(`دخول#${i + 1} reference=number`, inv.reference === inv.number);
  check(`دخول#${i + 1} subtotal`, inv.subtotal === expSubtotal, `${inv.subtotal} vs ${expSubtotal}`);
  check(`دخول#${i + 1} total`, inv.total === expTotal, `${inv.total} vs ${expTotal}`);
  check(`دخول#${i + 1} amountDue`, inv.amountDue === expTotal - s.paid, `${inv.amountDue}`);
  check(`دخول#${i + 1} أرقام آمنة`, [inv.subtotal, inv.total, inv.amountDue].every(Number.isSafeInteger));
  await verifyBatch(inv.number, {
    purchase_invoice: (l) => l.party && l.dr === 0 && l.cr === inv.total,
    inventory_asset: (l) => !l.party && l.dr === inv.total && l.cr === 0,
    ...(s.paid > 0 ? {
      payment_out: (l) => l.party && l.dr === s.paid && l.cr === 0,
      cash: (l) => !l.party && l.dr === 0 && l.cr === s.paid,
    } : {}),
  });
  console.log(`ENT ${inv.number}: أصناف=${inv.subtotal.toLocaleString("en-US")} إجمالي=${inv.total.toLocaleString("en-US")} متبقٍ=${inv.amountDue.toLocaleString("en-US")}`);
}

// ════════ 5 SALE INVOICES ════════
console.log("\n════════ فواتير الخروج ════════");
const saleSpecs = [
  { cus: customers[0], lines: [{ r: 0, kg: 3.5, pcs: 1, price: 12000000, disc: 1000000 }], invDisc: 500000, tax: 800000, ship: 300000, paid: 40000000 },
  { cus: customers[1], lines: [{ r: 1, kg: 15, pcs: 4, price: 95000, disc: 125000 }], invDisc: 200000, tax: 0, ship: 50000, paid: 1000000 },
  { cus: customers[2], lines: [{ r: 2, kg: 8.75, pcs: 3, price: 2400000, disc: 0 }, { r: 3, kg: 4.25, pcs: 2, price: 1900000, disc: 275000 }], invDisc: 350000, tax: 450000, ship: 0, paid: 5000000 },
  { cus: customers[0], lines: [{ r: 0, kg: 2.25, pcs: 1, price: 13500000, disc: 1500000 }], invDisc: 0, tax: 700000, ship: 200000, paid: 0 },
  { cus: customers[1], lines: [{ r: 1, kg: 22.22, pcs: 6, price: 88000, disc: 48400 }, { r: 0, kg: 1.5, pcs: 1, price: 11000000, disc: 0 }], invDisc: 111111, tax: 222222, ship: 333333, paid: 20000000 },
];

for (let i = 0; i < saleSpecs.length; i++) {
  const s = saleSpecs[i];
  const body = {
    type: "sale", date: TODAY, partyId: s.cus, partyType: "customer",
    currency: "SYP", discount: s.invDisc, tax: s.tax, shipping: s.ship,
    paid: s.paid, ...(s.paid > 0 ? { paymentMethod: "cash" } : {}),
    lines: s.lines.map((l) => ({
      fabricId: rolls[l.r].fabricId, colorId: rolls[l.r].colorId, rollId: rolls[l.r].id,
      quantityKg: l.kg, pieces: l.pcs, pricePerKg: l.price, discountAmount: l.disc,
    })),
  };
  const expSubtotal = body.lines.reduce((t, l) => t + Math.max(0, Math.round(l.quantityKg * l.pricePerKg - l.discountAmount)), 0);
  const expTotal = expSubtotal - s.invDisc + s.tax + s.ship;
  // expected COGS from stored roll cost (numeric(12,2))
  let expCogs = 0;
  for (const l of s.lines) expCogs += Math.round(Math.round(l.kg * 100) / 100 * Number(rolls[l.r].costKg));

  const inv = await api("POST", "/api/invoices", body);
  check(`بيع#${i + 1} رقم مرجعي INV`, /^INV-\d{4}-\d{4}$/.test(inv.number), inv.number);
  check(`بيع#${i + 1} subtotal`, inv.subtotal === expSubtotal, `${inv.subtotal} vs ${expSubtotal}`);
  check(`بيع#${i + 1} total`, inv.total === expTotal, `${inv.total} vs ${expTotal}`);
  check(`بيع#${i + 1} amountDue`, inv.amountDue === expTotal - s.paid);

  await verifyBatch(inv.number, {
    sales_invoice: (l) => l.party && l.dr === inv.total && l.cr === 0,
    sales_revenue: (l) => !l.party && l.dr === 0 && l.cr === inv.total,
    ...(expCogs > 0 ? {
      cogs_expense: (l) => !l.party && l.dr === expCogs,
      inventory_asset: (l) => !l.party && l.cr === expCogs,
    } : {}),
    ...(s.paid > 0 ? {
      receipt_in: (l) => l.party && l.cr === s.paid && l.dr === 0,
      cash: (l) => !l.party && l.dr === s.paid && l.cr === 0,
    } : {}),
  });
  const profit = inv.total - expCogs;
  console.log(`${inv.number}: إيراد=${inv.total.toLocaleString("en-US")} COGS=${expCogs.toLocaleString("en-US")} ربح إجمالي=${profit.toLocaleString("en-US")} (${((profit / inv.total) * 100).toFixed(1)}%)`);
}

console.log("\n──────────────────────────────");
console.log(allOk ? "★ جميع الفحوصات نجحت ★" : "!! توجد فحوصات فاشلة !!");
console.log(results.filter(r => r.startsWith("✗")).join("\n") || `${results.length} فحصاً ناجحاً`);
