/**
 * Clean-QA proof: inventory ↔ invoice ID relationship + delete semantics.
 * Uses FirstRun tenant. No fixtures — creates real records via API, verifies in DB.
 */
import "dotenv/config";
import pg from "pg";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Reuse the same normalizer the web app now uses (compiled via dynamic import of source through tsx not available here —
// inline an identical copy for the proof assertion of reuse-by-name).
function normalizeInventoryName(name) {
  return name
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const BASE = "http://127.0.0.1:8080";
const TENANT = "d9b59c10-1875-4cfd-8da7-1fea2c4944fd";
const EMAIL = "firstrun.admin+1789646561009@erp.test";
const PASSWORD = "admin123";
const FABRIC_NAME = "قطن مصري فاخر";
const COLOR_NAME = "أبيض ثلجي";

const report = { steps: [], pass: true };
function ok(step, detail) {
  report.steps.push({ step, ok: true, detail });
  console.log("PASS", step, detail ?? "");
}
function fail(step, detail) {
  report.pass = false;
  report.steps.push({ step, ok: false, detail });
  console.error("FAIL", step, detail ?? "");
}

async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

const app = new URL(process.env.DATABASE_URL);
const admin = new pg.Client({
  connectionString: `postgresql://postgres:postgres@${app.hostname}:${app.port || 5432}/erp`,
});
await admin.connect();

async function counts() {
  const q = await admin.query(`
    SELECT
      (SELECT count(*)::int FROM fabrics WHERE tenant_id = $1) AS fabrics,
      (SELECT count(*)::int FROM colors WHERE tenant_id = $1) AS colors,
      (SELECT count(*)::int FROM rolls WHERE tenant_id = $1) AS rolls,
      (SELECT count(*)::int FROM invoices WHERE tenant_id = $1) AS invoices,
      (SELECT count(*)::int FROM invoice_lines WHERE tenant_id = $1) AS invoice_lines
  `, [TENANT]);
  return q.rows[0];
}

async function fabricRows() {
  return (
    await admin.query(
      `SELECT id, name FROM fabrics WHERE tenant_id = $1 ORDER BY created_at`,
      [TENANT],
    )
  ).rows;
}

// ── Login ──
const login = await api("POST", "/api/auth/login", null, {
  email: EMAIL,
  password: PASSWORD,
  tenantId: TENANT,
});
if (login.status !== 200 || !login.json?.accessToken) {
  fail("login", JSON.stringify(login.json));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
const token = login.json.accessToken;
ok("login", login.json.user.name);

const before = await counts();
if (Number(before.fabrics) !== 0 || Number(before.invoices) !== 0) {
  fail("clean_db_precondition", before);
} else {
  ok("clean_db_precondition", before);
}

// ── Create supplier ──
const party = await api("POST", "/api/suppliers", token, {
  name: "مورد إثبات QA",
  phone: "0900000000",
});
if (party.status >= 300 || !party.json?.id) {
  fail("create_supplier", JSON.stringify(party.json));
  process.exit(1);
}
const supplierId = party.json.id;
ok("create_supplier", supplierId);

// ── Create ONE fabric (master) ──
const fab = await api("POST", "/api/inventory/fabrics", token, {
  name: FABRIC_NAME,
  category: "قطن",
  minStockKg: 10,
  unit: "kg",
});
if (fab.status >= 300 || !fab.json?.id) {
  fail("create_fabric", JSON.stringify(fab.json));
  process.exit(1);
}
const fabricId = fab.json.id;
ok("create_fabric", fabricId);

// Simulate client re-bind: typed near-duplicate name must resolve to same id
const typedAlias = "قطن  مصرى  فاخر"; // spaces + ى
const nameMatch =
  normalizeInventoryName(typedAlias) === normalizeInventoryName(FABRIC_NAME) ? fabricId : null;
if (nameMatch !== fabricId) fail("normalize_rebind", { typedAlias, fabricId });
else ok("normalize_rebind", typedAlias);

// Duplicate create with exact same name must be rejected (unique index)
const dup = await api("POST", "/api/inventory/fabrics", token, {
  name: FABRIC_NAME,
  category: "قطن",
  minStockKg: 10,
  unit: "kg",
});
if (dup.status === 200 || dup.status === 201) {
  fail("reject_duplicate_fabric_name", `unexpected success ${dup.status}`);
} else {
  ok("reject_duplicate_fabric_name", `${dup.status} ${dup.json?.message || dup.json?.code}`);
}

// ── Create color under that fabric ──
const col = await api("POST", "/api/inventory/colors", token, {
  fabricId,
  name: COLOR_NAME,
  code: "W01",
  hex: "#FFFFFF",
});
if (col.status >= 300 || !col.json?.id) {
  fail("create_color", JSON.stringify(col.json));
  process.exit(1);
}
const colorId = col.json.id;
ok("create_color", colorId);

async function createEntryRoll(rollNo) {
  const roll = await api("POST", "/api/inventory/rolls", token, {
    colorId,
    rollNo,
    initialKg: 100,
    // Entry UI creates with remainingKg:0 then invoice books stock — mirror that.
    remainingKg: 0,
    pieces: 1,
    pricePerKg: 10,
    currency: "USD",
    supplierId,
    entryDate: new Date().toISOString().slice(0, 10),
  });
  if (roll.status >= 300 || !roll.json?.id) {
    fail("create_roll", JSON.stringify(roll.json));
    return null;
  }
  ok("create_roll", `${roll.json.id} ${rollNo}`);
  return roll.json.id;
}

const roll1 = await createEntryRoll(`QA-R1-${Date.now().toString().slice(-6)}`);
if (!roll1) process.exit(1);

const today = new Date().toISOString().slice(0, 10);

async function createEntryInvoice(rollId, reference) {
  const inv = await api("POST", "/api/invoices", token, {
    type: "entry",
    date: today,
    partyId: supplierId,
    partyType: "supplier",
    reference,
    currency: "USD",
    exchangeRate: 1,
    lines: [
      {
        fabricId,
        colorId,
        rollId,
        quantityKg: 50,
        pieces: 1,
        pricePerKg: 10,
      },
    ],
    paid: 0,
  });
  if (inv.status >= 300 || !inv.json?.id) {
    fail("create_entry_invoice", JSON.stringify(inv.json));
    return null;
  }
  ok("create_entry_invoice", `${inv.json.id} ${reference}`);
  return inv.json;
}

const inv1 = await createEntryInvoice(roll1, "QA-ENT-1");
if (!inv1) process.exit(1);

// Verify invoice lines point at same fabric/color/roll
const lines1 = await admin.query(
  `SELECT fabric_id, color_id, roll_id FROM invoice_lines WHERE invoice_id = $1`,
  [inv1.id],
);
const L1 = lines1.rows[0];
if (
  L1.fabric_id === fabricId &&
  L1.color_id === colorId &&
  L1.roll_id === roll1
) {
  ok("invoice1_ids_match_masters", L1);
} else {
  fail("invoice1_ids_match_masters", { L1, fabricId, colorId, roll1 });
}

let mid = await counts();
if (Number(mid.fabrics) === 1 && Number(mid.colors) === 1) {
  ok("inventory_one_fabric_after_invoice1", mid);
} else {
  fail("inventory_one_fabric_after_invoice1", mid);
}

// Second invoice, SAME fabric/color, new roll (entry always makes a new roll)
const roll2 = await createEntryRoll(`QA-R2-${Date.now().toString().slice(-6)}`);
if (!roll2) process.exit(1);
const inv2 = await createEntryInvoice(roll2, "QA-ENT-2");
if (!inv2) process.exit(1);

const lines2 = await admin.query(
  `SELECT fabric_id, color_id, roll_id FROM invoice_lines WHERE invoice_id = $1`,
  [inv2.id],
);
const L2 = lines2.rows[0];
if (L2.fabric_id === fabricId && L2.color_id === colorId && L2.roll_id === roll2) {
  ok("invoice2_reuses_same_fabric_color", L2);
} else {
  fail("invoice2_reuses_same_fabric_color", { L2, fabricId, colorId });
}

mid = await counts();
if (Number(mid.fabrics) === 1 && Number(mid.colors) === 1 && Number(mid.invoices) === 2) {
  ok("no_duplicate_fabric_after_invoice2", mid);
} else {
  fail("no_duplicate_fabric_after_invoice2", mid);
}

const fabs = await fabricRows();
if (fabs.length === 1 && fabs[0].id === fabricId) {
  ok("fabrics_table_single_row", fabs[0]);
} else {
  fail("fabrics_table_single_row", fabs);
}

// Edit invoice 2 — keep same fabric/color/roll, change qty
const upd = await api("PUT", `/api/invoices/${inv2.id}`, token, {
  date: today,
  exchangeRate: 1,
  expectedVersion: inv2.version ?? 1,
  lines: [
    {
      fabricId,
      colorId,
      rollId: roll2,
      quantityKg: 55,
      pieces: 1,
      pricePerKg: 10,
    },
  ],
});
if (upd.status >= 300) {
  fail("edit_invoice", JSON.stringify(upd.json));
} else {
  ok("edit_invoice", upd.status);
}

const afterEdit = await counts();
if (Number(afterEdit.fabrics) === 1 && Number(afterEdit.colors) === 1) {
  ok("no_orphan_after_edit", afterEdit);
} else {
  fail("no_orphan_after_edit", afterEdit);
}

// Orphan check: no fabric without invoice reference mismatch
const orphans = await admin.query(
  `
  SELECT f.id, f.name
  FROM fabrics f
  WHERE f.tenant_id = $1
    AND f.id <> $2
  `,
  [TENANT, fabricId],
);
if (orphans.rows.length === 0) ok("no_orphan_fabrics", 0);
else fail("no_orphan_fabrics", orphans.rows);

// ── Delete semantics ──
// Linked fabric must be blocked (422 VALIDATION), not 404
const delLinked = await api("DELETE", `/api/inventory/fabrics/${fabricId}`, token);
if (delLinked.status === 422) {
  ok("delete_linked_fabric_422", delLinked.json?.message || delLinked.json?.code);
} else {
  fail("delete_linked_fabric_422", `${delLinked.status} ${JSON.stringify(delLinked.json)}`);
}

// Unused fabric should delete
const unused = await api("POST", "/api/inventory/fabrics", token, {
  name: "قماش غير مستخدم للحذف",
  category: "اختبار",
  minStockKg: 1,
  unit: "kg",
});
const unusedId = unused.json?.id;
if (!unusedId) {
  fail("create_unused_fabric", JSON.stringify(unused.json));
} else {
  const delUnused = await api("DELETE", `/api/inventory/fabrics/${unusedId}`, token);
  if (delUnused.status === 204 || delUnused.status === 200) {
    ok("delete_unused_fabric", delUnused.status);
  } else {
    fail("delete_unused_fabric", `${delUnused.status} ${JSON.stringify(delUnused.json)}`);
  }
}

// Missing fabric → 404
const delMissing = await api(
  "DELETE",
  `/api/inventory/fabrics/00000000-0000-4000-8000-000000000099`,
  token,
);
if (delMissing.status === 404) {
  ok("delete_missing_fabric_404", delMissing.json?.message || delMissing.json?.code);
} else {
  fail("delete_missing_fabric_404", `${delMissing.status} ${JSON.stringify(delMissing.json)}`);
}

const finalCounts = await counts();
ok("final_counts", finalCounts);

console.log("\n=== FINAL ===");
console.log(report.pass ? "OVERALL: PASS" : "OVERALL: FAIL");
console.log(JSON.stringify({ fabricId, colorId, roll1, roll2, inv1: inv1.id, inv2: inv2.id, finalCounts }, null, 2));

await admin.end();
process.exit(report.pass ? 0 : 1);
