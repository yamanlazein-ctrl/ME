// Sale #5 retry (valid paid) + independent aggregate audit over ALL field-test invoices.
import pg from "pg";

const TENANT = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const BASE = "http://127.0.0.1:8080";
const TODAY = new Date().toISOString().slice(0, 10);

const lr = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@erp.local", password: "admin123", tenantId: TENANT }),
});
const { accessToken } = await lr.json();
const H = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "X-Tenant-Id": TENANT };

// roll cost lookup
const dbc = new pg.Client("postgresql://postgres:postgres@localhost:5432/erp");
await dbc.connect();
const rolls = (await dbc.query(
  `select r.id, r.color_id "colorId", c.fabric_id "fabricId", r.price_per_kg::text "costKg"
   from rolls r join colors c on r.color_id=c.id order by r.created_at desc limit 4`
)).rows;

let allOk = true;
function check(label, cond, detail = "") {
  if (!cond) allOk = false;
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}${detail ? " — " + detail : ""}`);
}

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// ── Sale #5 (paid fixed to a valid partial) ──
const sup5 = { lines: [{ r: 1, kg: 22.22, pcs: 6, price: 88000, disc: 48400 }, { r: 0, kg: 1.5, pcs: 1, price: 11000000, disc: 0 }] };
const invDisc = 111111, tax = 222222, ship = 333333, paid = 15000000;
const expSubtotal = sup5.lines.reduce((t, l) => t + Math.max(0, Math.round(l.kg * l.price - l.disc)), 0);
const expTotal = expSubtotal - invDisc + tax + ship;
const expCogs = sup5.lines.reduce((t, l) => t + Math.round(Math.round(l.kg * 100) / 100 * Number(rolls[l.r].costKg)), 0);

const customers = (await api("GET", "/api/customers")).data ?? [];
const custId = customers[0]?.id ?? customers?.[0]?.id;
const inv = await api("POST", "/api/invoices", {
  type: "sale", date: TODAY,
  partyId: Array.isArray(customers) ? customers.find(c => c.name === "احمد")?.id ?? customers[0].id : custId,
  partyType: "customer", currency: "SYP", discount: invDisc, tax, shipping: ship, paid,
  paymentMethod: "cash",
  lines: sup5.lines.map((l) => ({
    fabricId: rolls[l.r].fabricId, colorId: rolls[l.r].colorId, rollId: rolls[l.r].id,
    quantityKg: l.kg, pieces: l.pcs, pricePerKg: l.price, discountAmount: l.disc,
  })),
});
check(`بيع#5 رقم مرجعي INV`, /^INV-\d{4}-\d{4}$/.test(inv.number), inv.number);
check(`بيع#5 subtotal`, inv.subtotal === expSubtotal, `${inv.subtotal} vs ${expSubtotal}`);
check(`بيع#${5} total`, inv.total === expTotal, `${inv.total} vs ${expTotal}`);

// ── Independent aggregate audit of ALL 10 batches straight from DB ──
console.log("\n── التدقيق المجمع المستقل (من قاعدة البيانات مباشرة) ──");
const numbers = ["ENT-2026-0002","ENT-2026-0003","ENT-2026-0004","ENT-2026-0005","ENT-2026-0006",
                 "INV-2026-0049","INV-2026-0050","INV-2026-0051","INV-2026-0052", inv.number];
const q = `
  select reference_number ref, type, debit::text dr, credit::text cr, currency,
         (party_id is not null) has_party
  from ledger_entries
  where status='active' and (
    reference_number = any($1) or reference_number like 'PAY-ENT-2026-000%' or reference_number like 'PAY-INV-2026-004%' or reference_number like 'RCP-INV-2026-004%' or reference_number = $2
  )`;
const { rows } = await dbc.query(q, [numbers, `PAY-${inv.number}`]);
await dbc.end();

const batches = new Map();
for (const x of rows) {
  const key = x.ref.startsWith("PAY-") || x.ref.startsWith("RCP-") ? x.ref.slice(4) : x.ref;
  if (!batches.has(key)) batches.set(key, { sum: 0, currencies: new Set(), types: {} });
  const b = batches.get(key);
  b.sum += Number(x.dr) - Number(x.cr);
  b.currencies.add(x.currency);
  (b.types[x.type] = b.types[x.type] || []).push({ dr: Number(x.dr), cr: Number(x.cr), party: x.has_party });
}

for (const num of numbers) {
  const b = batches.get(num);
  if (!b) { check(`${num} دفلة قيود`, false, "غير موجودة"); continue; }
  check(`${num} Σ(مدين−دائن)=0`, b.sum === 0, `Σ=${b.sum}`);
  check(`${num} عملة موحدة SYP`, b.currencies.size === 1 && b.currencies.has("SYP"));
  // direction assertions
  const dir = (t, pred) => {
    const legs = b.types[t] || [];
    check(`${num} ${t}`, legs.some(pred), JSON.stringify(legs));
  };
  if (num.startsWith("ENT")) {
    dir("purchase_invoice", l => l.party && l.cr > 0 && l.dr === 0);
    dir("inventory_asset", l => !l.party && l.dr > 0 && l.cr === 0);
    if (b.types.payment_out) {
      dir("payment_out", l => l.party && l.dr > 0 && l.cr === 0);
      dir("cash", l => !l.party && l.cr > 0 && l.dr === 0 && true);
    }
  } else {
    dir("sales_invoice", l => l.party && l.dr > 0 && l.cr === 0);
    dir("sales_revenue", l => !l.party && l.cr > 0 && l.dr === 0);
    if (b.types.cogs_expense) dir("cogs_expense", l => !l.party && l.dr > 0);
    if (b.types.inventory_asset) dir("inventory_asset", l => !l.party && l.cr > 0);
    if (b.types.receipt_in) dir("receipt_in", l => l.party && l.cr > 0 && l.dr === 0);
    if (b.types.cash) dir("cash", l => !l.party && l.dr > 0 && l.cr === 0);
  }
}
console.log(allOk ? "\n★ جميع فحوصات الدفلات العشرة نجحت ★" : "\n!! توجد إخفاقات !!");
