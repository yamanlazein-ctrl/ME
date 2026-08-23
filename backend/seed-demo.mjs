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

// login
{
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantId: TENANT }) });
  const b = await r.json();
  if (!r.ok) throw new Error("login failed: " + JSON.stringify(b));
  token = b.accessToken;
}
await c.connect();

// existing id sets (to avoid dupes on re-run)
const existingParties = {}; // name -> id
{
  const r = await c.query("SELECT id, name FROM parties");
  for (const x of r.rows) existingParties[x.name] = x.id;
}
const existingFabrics = {};
{
  const r = await c.query("SELECT id, name FROM fabrics");
  for (const x of r.rows) existingFabrics[x.name] = x.id;
}

// ---------- 1) Customers ----------
const customers = [
  ["محل الهدى للأقمشة", "حلب", "0999-111-222", "mahall-alhuda@test.com"],
  ["دار المنسوجات", "دمشق", "0888-333-444", "dar-almansujat@test.com"],
  ["بوتيك الأصيل", "حماة", "0977-555-666", "butik-alaseel@test.com"],
  ["مؤسسة النور التجارية", "حمص", "0966-777-888", "alnoor@test.com"],
  ["مخازن البركة", "حلب", "0955-999-000", "albaraka@test.com"],
  ["شركة الشرق للأقمشة", "دمشق", "0944-123-456", "alsharq@test.com"],
  ["محل الأناقة", "اللاذقية", "0933-654-321", "alanaqa@test.com"],
  ["ألبسة الناس", "طرطوس", "0922-111-333", "albas@test.com"],
];
const customerIds = [];
for (const [name, city, phone, mail] of customers) {
  const full = `(اختبار) ${name}`;
  if (existingParties[full]) { customerIds.push(existingParties[full]); continue; }
  const r = await api("POST", "/customers", { name: full, city, phone, email: mail, creditLimit: 0, currency: "SYP", notes: "TEST-ONLY عميل تجريبي" });
  if (r.status !== 201) log("customer ERR:", name, r.status, JSON.stringify(r.data));
  else customerIds.push(r.data.id);
}
log("customers:", customerIds.length);

// ---------- 2) Suppliers ----------
const suppliers = [
  ["مصنع النسيج الحديث", "حلب"],
  ["مطابع الشرق", "دمشق"],
  ["مورد القطن التركي", "إسطنبول (فرع حلب)"],
  ["شركة الأقمشة السورية", "حماة"],
  ["مصنع الصباغة", "حمص"],
];
const supplierIds = [];
for (const [name, city] of suppliers) {
  const full = `(اختبار) ${name}`;
  if (existingParties[full]) { supplierIds.push(existingParties[full]); continue; }
  const r = await api("POST", "/suppliers", { name: full, city, creditLimit: 0, currency: "SYP", notes: "TEST-ONLY مورد تجريبي" });
  if (r.status !== 201) log("supplier ERR:", name, r.status, JSON.stringify(r.data));
  else supplierIds.push(r.data.id);
}
log("suppliers:", supplierIds.length);

// ---------- 3) Fabrics ----------
const fabricDefs = [
  ["بلاك أوت", "خلية"], ["قطن سادة", "قطن"], ["قطن مطبوع", "قطن"], ["شيفون", "خام"],
  ["بولوص", "قطن"], ["جورجيت", "شيفون"], ["ساتان", "خام"], ["كتان", "كتان"],
];
const fabricIds = [];
for (const [name, cat] of fabricDefs) {
  const full = `(اختبار) ${name}`;
  if (existingFabrics[full]) { fabricIds.push(existingFabrics[full]); continue; }
  const r = await api("POST", "/inventory/fabrics", { name: full, category: cat, unit: "kg", minStockKg: 10, notes: "TEST-ONLY" });
  if (r.status !== 201) log("fabric ERR:", name, r.status, JSON.stringify(r.data));
  else fabricIds.push(r.data.id);
}
log("fabrics:", fabricIds.length);

// ---------- 4) Colors ----------
const colorPalettes = {
  "بلاك أوت": ["أسود", "كحلي", "رمادي"], "قطن سادة": ["أبيض", "بيج", "رمادي فاتح"],
  "قطن مطبوع": ["أزرق", "أحمر", "أخضر"], "شيفون": ["بنفسجي", "وردي", "ذهبي"],
  "بولوص": ["بني", "زيتوني", "أزرق داكن"], "جورجيت": ["موف", "فيروزي", "سيلفر"],
  "ساتان": ["أحمر غامق", "أسود لامع", "كريمي"], "كتان": ["رمادي", "بيج داكن", "أبيض"],
};
const colorByFabric = {}; // fabName -> [colorIds]
// fetch existing colors
{
  const r = await c.query("SELECT id, name, fabric_id FROM colors");
  const fabIdByName = {};
  for (let i = 0; i < fabricDefs.length; i++) fabIdByName[fabricDefs[i][0]] = fabricIds[i];
  for (const x of r.rows) {
    for (const [fi, [fname]] of fabricDefs.entries()) {
      if (fabIdByName[fname] === x.fabric_id) (colorByFabric[fname] = colorByFabric[fname] || []).push(x.id);
    }
  }
}
for (let fi = 0; fi < fabricDefs.length; fi++) {
  const fname = fabricDefs[fi][0];
  const fabId = fabricIds[fi];
  const palette = colorPalettes[fname] || ["أبيض", "أسود", "رمادي"];
  const have = colorByFabric[fname] || [];
  for (const cn of palette) {
    if (have.length >= palette.length) break;
    // skip if this color already exists under this fabric (by name suffix)
    const existingR = await c.query("SELECT id FROM colors WHERE fabric_id=$1 AND name=$2", [fabId, `(اختبار) ${cn}`]);
    if (existingR.rows.length > 0) { (colorByFabric[fname] = colorByFabric[fname] || []).push(existingR.rows[0].id); continue; }
    const r = await api("POST", "/inventory/colors", { fabricId: fabId, name: `(اختبار) ${cn}`, code: `C-T${fi}`, notes: "TEST-ONLY" });
    if (r.status !== 201) log("color ERR:", fname, cn, r.status, JSON.stringify(r.data));
    else (colorByFabric[fname] = colorByFabric[fname] || []).push(r.data.id);
  }
}
log("colors per fabric:", Object.fromEntries(Object.entries(colorByFabric).map(([k, v]) => [k, v.length])));

// ---------- 5) Rolls ----------
const rollPlans = [
  // [fabricIdx, colorIdxInPalette, initialKg, viaEntry]
  [0,0,120,true],[0,1,90,true],[1,0,200,true],[1,1,180,false],
  [2,0,150,false],[2,1,110,true],[3,0,80,true],[3,2,60,false],
  [4,0,95,true],[4,2,70,false],[5,0,55,true],[5,1,40,false],
  [6,1,130,true],[6,2,100,false],[7,0,75,true],[7,2,50,false],
];
const supplierForRoll = supplierIds[0];
let s = 0;
const createdRolls = [];
// existing rollNos to avoid dup
const existingRollNos = new Set((await c.query("SELECT roll_no FROM rolls")).rows.map((x) => x.roll_no));
for (const [fi, ci, kg, viaEntry] of rollPlans) {
  const fname = fabricDefs[fi][0];
  const fabColors = colorByFabric[fname] || [];
  if (ci >= fabColors.length) continue;
  const colorId = fabColors[ci];
  let rollNo = `RT-${String(++s).padStart(4, "0")}`;
  if (existingRollNos.has(rollNo)) rollNo += "-x";
  const price = 80 + ((fi * 53 + ci * 97) % 700);
  const body = {
    colorId,
    rollNo,
    dyeBatch: `DB-T${fi}-${ci}`,
    initialKg: kg,
    remainingKg: viaEntry ? 0 : kg,
    pieces: 1,
    pricePerKg: price,
    salePricePerKg: price + 40,
    currency: "SYP",
    supplierId: supplierForRoll,
    entryDate: "2026-08-01",
  };
  const r = await api("POST", "/inventory/rolls", body);
  if (r.status !== 201) log("roll ERR:", rollNo, r.status, JSON.stringify(r.data));
  else createdRolls.push({ id: r.data.id, rollNo, kg, viaEntry, price, colorId, fabricName: fname });
}
log("rolls:", createdRolls.length, "viaEntry:", createdRolls.filter((x) => x.viaEntry).length, "direct:", createdRolls.filter((x) => !x.viaEntry).length);

fs2json();

async function fs2json() {
  await c.end();
  process.exit(0);
}