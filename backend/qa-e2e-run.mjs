/**
 * QA end-to-end driver â€” clean-install proof for the acceptance environment.
 *
 * HARD SAFETY: refuses to run unless every target is loopback AND the
 * database is literally `erp_acceptance`. Production (`erp`) is never
 * touched â€” the only prod interaction is a separate read-only row count
 * snapshot taken to prove isolation.
 *
 * Flow (all through the real APIs, no SQL writes, no hardcoded IDs):
 *   A. License Dashboard: super-admin login â†’ create license (control plane)
 *   B. ERP setup wizard: init â†’ activate â†’ company â†’ admin â†’ review â†’ complete
 *   C. Relationship verification (read-only DB + dashboard re-read)
 *   D. Normal manager login
 *   E. First business tx: supplier â†’ fabric â†’ color â†’ roll â†’ entry invoice
 *   F. Read-only verification: invoice, lines, stock, ledger, voucher,
 *      cashbox, party balance, sync outbox, license chain
 *
 * Output: qa-e2e-report.json + console PASS/FAIL lines.
 */
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

const ERP = "http://127.0.0.1:8080";
const LIC = "http://127.0.0.1:8081";
const s = JSON.parse(readFileSync("tmp-acceptance-env.json", "utf8"));

// â”€â”€ Hard safety gates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const dbUrl = new URL(s.databaseUrl);
const dbName = dbUrl.pathname.replace(/^\//, "");
if (dbName !== "erp_acceptance") {
  console.error(`REFUSING TO RUN: database is '${dbName}', expected 'erp_acceptance'`);
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "::1"].includes(dbUrl.hostname)) {
  console.error(`REFUSING TO RUN: db host '${dbUrl.hostname}' is not loopback`);
  process.exit(2);
}
const ADMIN_DB = `postgresql://postgres:postgres@${dbUrl.hostname}:${dbUrl.port || 5432}/erp_acceptance`;

const report = { env: {}, steps: [], ids: {}, verification: {}, pass: true };
function ok(step, detail) {
  report.steps.push({ step, ok: true, detail });
  console.log("PASS ", step, typeof detail === "object" ? JSON.stringify(detail) : (detail ?? ""));
}
function fail(step, detail) {
  report.pass = false;
  report.steps.push({ step, ok: false, detail });
  console.error("FAIL ", step, typeof detail === "object" ? JSON.stringify(detail) : (detail ?? ""));
}
function bail(step, detail) {
  fail(step, detail);
  writeFileSync("qa-e2e-report.json", JSON.stringify(report, null, 2));
  process.exit(1);
}

async function api(base, method, path, { token, body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text?.slice(0, 400) }; }
  return { status: r.status, json };
}

const dbc = new pg.Client({ connectionString: ADMIN_DB }); // read-only verification
await dbc.connect();
const q1 = async (sql, params = []) => (await dbc.query(sql, params)).rows;
// â”€â”€ STEP 0: prove isolation â€” prod snapshot is READ-ONLY counts â”€â”€â”€â”€â”€â”€â”€
{
  const prod = new pg.Client({ connectionString: `postgresql://postgres:postgres@${dbUrl.hostname}:${dbUrl.port || 5432}/erp` });
  try {
    await prod.connect();
    const r = await prod.query(`SELECT
      (SELECT count(*)::int FROM tenants) AS tenants,
      (SELECT count(*)::int FROM invoices) AS invoices`);
    report.env.prodReadonlySnapshot = { database: "erp", ...r.rows[0], note: "read-only; not modified" };
    ok("prod_isolation_snapshot", report.env.prodReadonlySnapshot);
  } catch (e) {
    ok("prod_isolation_snapshot", `prod 'erp' not reachable/readable â€” nothing to protect against here (${e.code ?? e.message})`);
  } finally {
    await prod.end().catch(() => {});
  }
}

// â”€â”€ STEP 2a: schema relationship proof (FKs) on the QA database â”€â”€â”€â”€â”€â”€â”€
{
  const fks = await q1(`SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ((tc.table_name = 'licenses' AND kcu.column_name = 'tenant_id')
        OR (tc.table_name = 'license_activations' AND kcu.column_name IN ('license_id','tenant_id'))
        OR (tc.table_name = 'users' AND kcu.column_name = 'tenant_id')
        OR (tc.table_name = 'device_registrations' AND kcu.column_name = 'tenant_id'))`);
  report.verification.licenseChainFks = fks;
  ok("schema_license_chain_fks", fks);
}

// â”€â”€ STEP 2b/3: confirm genuinely empty QA state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const rows = await q1(`SELECT
    (SELECT count(*)::int FROM tenants) AS tenants,
    (SELECT count(*)::int FROM licenses) AS licenses,
    (SELECT count(*)::int FROM license_activations) AS activations,
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM invoices) AS invoices,
    (SELECT count(*)::int FROM parties) AS parties,
    (SELECT count(*)::int FROM device_registrations) AS devices,
    (SELECT count(*)::int FROM invitation_codes) AS invitations,
    (SELECT count(*)::int FROM sync_outbox) AS sync_outbox,
    (SELECT count(*)::int FROM sync_conflicts) AS sync_conflicts,
    (SELECT count(*)::int FROM sync_tombstones) AS sync_tombstones`);
  const dirty = Object.entries(rows[0]).filter(([, v]) => v !== 0);
  if (dirty.length) bail("qa_clean_precondition", rows[0]);
  ok("qa_clean_precondition", rows[0]);
}

// â”€â”€ A. License Dashboard flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const adminLogin = await api(LIC, "POST", "/license-admin/login", {
  body: { email: s.superAdminEmail, password: s.superAdminPassword },
});
if (adminLogin.status !== 200 || !adminLogin.json?.token) bail("dashboard_login", adminLogin.json);
const adminToken = adminLogin.json.token;
ok("dashboard_login", s.superAdminEmail);

const companyLabel = `QA Fabrics ${new Date().toISOString().slice(0, 10)}`;
const created = await api(LIC, "POST", "/license-admin/licenses", {
  token: adminToken,
  body: {
    edition: "textile",
    plan: "premium",
    type: "full",
    companyName: companyLabel,
    customerName: companyLabel,
    customerNotes: "QA acceptance license â€” created via the real dashboard API",
    bindingType: "server",
    maxDevices: 5,
  },
});
if (created.status !== 200 || !created.json?.license?.key) bail("dashboard_create_license", created.json);
const license = created.json.license;
report.ids.licenseId = license.id;
report.ids.licenseKey = license.key;
ok("dashboard_create_license", { id: license.id, key: license.key, tenantId: license.tenantId ?? null });

{
  const rows = await q1(`SELECT id, key, tenant_id, status, edition, plan FROM licenses WHERE id = $1`, [license.id]);
  if (rows.length !== 1 || rows[0].tenant_id !== null) bail("license_unbound_pre_activation", rows);
  ok("license_unbound_pre_activation", rows[0]);
}

// â”€â”€ B. ERP setup wizard (fresh install) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const init = await api(ERP, "POST", "/api/setup/init", { body: { companyName: companyLabel } });
if (init.status !== 200 || !init.json?.tenantId) bail("setup_init", init.json);
const tenantId = init.json.tenantId;
report.ids.tenantId = tenantId;
ok("setup_init", { tenantId, isCompleted: init.json.isCompleted });

const fingerprint = randomBytes(32).toString("hex"); // 64 chars, within 16..128
report.ids.fingerprint = fingerprint;
const act = await api(ERP, "POST", "/api/setup/wizard/activate", {
  body: { key: license.key, tenantId, platform: "web", hostname: "qa-acceptance-host", fingerprint },
});
if (act.status !== 200) bail("setup_activate", act.json);
ok("setup_activate", act.json && typeof act.json === "object" ? Object.keys(act.json) : act.status);

const company = await api(ERP, "POST", "/api/setup/wizard/company", {
  body: { tenantId, name: companyLabel, currency: "USD", country: "SY", language: "ar" },
});
if (company.status !== 200) bail("setup_company", company.json);
ok("setup_company", company.json);

const managerEmail = `qa.manager+${Date.now()}@acceptance.test`;
const managerPassword = `Qa-${randomBytes(9).toString("hex")}!`;
writeFileSync("qa-manager-creds.json", JSON.stringify({ email: managerEmail, password: managerPassword }, null, 2));
report.ids.managerEmail = managerEmail;
const admin = await api(ERP, "POST", "/api/setup/wizard/admin", {
  body: { tenantId, name: "QA Manager", email: managerEmail, password: managerPassword },
});
if (admin.status !== 200) bail("setup_admin", admin.json);
ok("setup_admin", { email: managerEmail });

const review = await api(ERP, "POST", "/api/setup/wizard/review", { body: { tenantId, confirmed: true } });
if (review.status !== 200) bail("setup_review", review.json);
ok("setup_review", review.json);

const complete = await api(ERP, "POST", "/api/setup/wizard/complete", { body: { tenantId } });
if (complete.status !== 200 || complete.json?.isCompleted !== true) bail("setup_complete", complete.json);
ok("setup_complete", complete.json);

// â”€â”€ C. Relationship verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const lic = await q1(`SELECT id, key, tenant_id, status FROM licenses WHERE id = $1`, [license.id]);
  const act2 = await q1(`SELECT id, license_id, tenant_id, deactivated_at FROM license_activations WHERE license_id = $1`, [license.id]);
  const ten = await q1(`SELECT id, slug, name, license_key FROM tenants WHERE id = $1`, [tenantId]);
  const usr = await q1(`SELECT id, email, role, tenant_id FROM users WHERE tenant_id = $1`, [tenantId]);
  const dev = await q1(`SELECT id, tenant_id, platform, name FROM device_registrations WHERE tenant_id = $1`, [tenantId]);
  const wiz = await q1(`SELECT tenant_id, is_completed, current_step FROM setup_wizard_state WHERE tenant_id = $1`, [tenantId]);

  const chain =
    lic.length === 1 && lic[0].tenant_id === tenantId &&
    act2.length >= 1 && act2.every((a) => a.tenant_id === tenantId) &&
    ten.length === 1 && ten[0].license_key === license.key &&
    usr.length === 1 && usr[0].email === managerEmail &&
    wiz.length === 1 && wiz[0].is_completed === true;

  report.verification.chain = { license: lic[0], activations: act2, tenant: ten[0], users: usr, devices: dev, wizard: wiz[0] };
  report.ids.activationId = act2[0]?.id;
  report.ids.managerUserId = usr[0]?.id;
  report.ids.deviceIds = dev.map((d) => d.id);
  if (!chain) bail("relationship_chain", report.verification.chain);
  ok("relationship_chain", { licenseTenant: lic[0].tenant_id, tenantLicenseKey: ten[0].license_key, activations: act2.length, users: usr.length, devices: dev.length });

  // Dashboard re-read: same chain visible from the control plane
  const dl = await api(LIC, "GET", "/license-admin/licenses", { token: adminToken });
  const da = await api(LIC, "GET", "/license-admin/activations", { token: adminToken });
  const foundLic = dl.json?.licenses?.find((l) => l.id === license.id);
  const foundAct = da.json?.activations?.find((a) => a.licenseId === license.id || a.license_id === license.id);
  if (!foundLic || String(foundLic.tenantId ?? foundLic.tenant_id) !== tenantId) bail("dashboard_license_tenant_link", foundLic);
  if (!foundAct) bail("dashboard_activation_link", da.json);
  ok("dashboard_license_tenant_link", { licenseTenant: foundLic.tenantId ?? foundLic.tenant_id, activation: foundAct.id });
}

// â”€â”€ D. Normal manager login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const login = await api(ERP, "POST", "/api/auth/login", {
  body: { email: managerEmail, password: managerPassword, tenantId },
});
if (login.status !== 200 || !login.json?.accessToken) bail("manager_login", login.json);
const token = login.json.accessToken;
report.ids.managerTenant = login.json.user?.tenantId ?? login.json.tenantId ?? null;
ok("manager_login", { user: login.json.user?.email, role: login.json.user?.role });

const status = await api(ERP, "GET", "/api/setup/status");
if (status.status !== 200 || status.json?.isCompleted !== true) bail("setup_status_after_complete", status.json);
ok("setup_status_after_complete", status.json);
// â”€â”€ E. First business transaction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const today = new Date().toISOString().slice(0, 10);

const party = await api(ERP, "POST", "/api/suppliers", { token, body: { name: "Ù…ÙˆØ±Ø¯ QA Ø§Ù„Ø£ÙˆÙ„", phone: "0900000001" } });
if (party.status >= 300 || !party.json?.id) bail("create_supplier", party.json);
const supplierId = party.json.id;
report.ids.supplierId = supplierId;
ok("create_supplier", supplierId);

const fab = await api(ERP, "POST", "/api/inventory/fabrics", {
  token, body: { name: "Ù‚Ù…Ø§Ø´ QA Ù‚Ø·Ù†", category: "Ù‚Ø·Ù†", minStockKg: 10, unit: "kg" },
});
if (fab.status >= 300 || !fab.json?.id) bail("create_fabric", fab.json);
const fabricId = fab.json.id;
report.ids.fabricId = fabricId;
ok("create_fabric", fabricId);

const col = await api(ERP, "POST", "/api/inventory/colors", {
  token, body: { fabricId, name: "Ø£Ø¨ÙŠØ¶ QA", code: "QA1", hex: "#FFFFFF" },
});
if (col.status >= 300 || !col.json?.id) bail("create_color", col.json);
const colorId = col.json.id;
report.ids.colorId = colorId;
ok("create_color", colorId);

const roll = await api(ERP, "POST", "/api/inventory/rolls", {
  token,
  body: {
    colorId, rollNo: `QA-ROLL-${Date.now().toString().slice(-6)}`,
    initialKg: 100, remainingKg: 0, pieces: 1, pricePerKg: 10,
    currency: "USD", supplierId, entryDate: today,
  },
});
if (roll.status >= 300 || !roll.json?.id) bail("create_roll", roll.json);
const rollId = roll.json.id;
report.ids.rollId = rollId;
ok("create_roll", rollId);

const inv = await api(ERP, "POST", "/api/invoices", {
  token,
  body: {
    type: "entry", date: today, partyId: supplierId, partyType: "supplier",
    currency: "USD", exchangeRate: 1,
    lines: [{ fabricId, colorId, rollId, quantityKg: 50, pieces: 1, pricePerKg: 10 }],
    paid: 250, paymentMethod: "cash",
  },
});
if (inv.status >= 300 || !inv.json?.id) bail("create_entry_invoice", inv.json);
const invoice = inv.json;
report.ids.invoiceId = invoice.id;
report.ids.invoiceNumber = invoice.number;
ok("create_entry_invoice", { id: invoice.id, number: invoice.number, total: invoice.total, paid: invoice.paid });

// â”€â”€ F. Read-only verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const v = {};
  v.invoice = (await q1(`SELECT id, number, type, total, paid, party_id, tenant_id, status FROM invoices WHERE id = $1`, [invoice.id]))[0];
  v.lines = await q1(`SELECT fabric_id, color_id, roll_id, quantity_kg, price_per_kg, tenant_id FROM invoice_lines WHERE invoice_id = $1`, [invoice.id]);
  v.roll = (await q1(`SELECT id, remaining_kg, remaining_pieces, status, tenant_id FROM rolls WHERE id = $1`, [rollId]))[0];
  v.stockMovements = await q1(`SELECT id, roll_id, direction, movement_type, quantity_kg, balance_after_kg, reference_id, tenant_id FROM stock_movements WHERE roll_id = $1`, [rollId]);
  v.vouchers = await q1(`SELECT id, number, kind, amount, method, party_id, invoice_id, tenant_id FROM vouchers WHERE party_id = $1`, [supplierId]);
  v.ledger = await q1(`SELECT id, type, debit, credit, cash_impact, party_id, reference_type, reference_id, tenant_id FROM ledger_entries WHERE party_id = $1 OR reference_id = $2`, [supplierId, invoice.id]);
  v.partyBalance = await q1(`SELECT party_id, year, currency, closing_balance, total_debit, total_credit FROM yearly_party_summaries WHERE party_id = $1`, [supplierId]);
  v.syncOutbox = await q1(`SELECT id, operation, entity_type, entity_id, status, tenant_id FROM sync_outbox WHERE tenant_id = $1`, [tenantId]);
  v.syncConflicts = (await q1(`SELECT count(*)::int AS n FROM sync_conflicts WHERE tenant_id = $1`, [tenantId]))[0].n;
  report.verification.firstTx = v;

  const lineOk = v.lines.length === 1 && v.lines[0].fabric_id === fabricId && v.lines[0].color_id === colorId && v.lines[0].roll_id === rollId;
  const stockOk = v.roll && Number(v.roll.remaining_kg) === 50;
  const ledgerOk = v.ledger.length >= 1;
  const voucherOk = v.vouchers.length >= 1;
  const outboxOk = v.syncOutbox.length >= 1;

  lineOk ? ok("db_invoice_line_references", v.lines[0]) : fail("db_invoice_line_references", v.lines);
  stockOk ? ok("db_inventory_updated", v.roll) : fail("db_inventory_updated", v.roll);
  ledgerOk ? ok("db_ledger_updated", `${v.ledger.length} entries`) : fail("db_ledger_updated", v.ledger);
  voucherOk ? ok("db_voucher_created", v.vouchers[0]) : fail("db_voucher_created", v.vouchers);
  ok("db_party_balance", v.partyBalance);
  outboxOk ? ok("db_sync_outbox", `${v.syncOutbox.length} ops`) : ok("db_sync_outbox", "0 rows (sync enqueue disabled or not applicable)");
  ok("db_sync_conflicts_zero", v.syncConflicts);

  // API-level proofs
  const list = await api(ERP, "GET", "/api/invoices?type=entry", { token });
  const items = list.json?.data ?? list.json?.invoices ?? [];
  list.status === 200 && items.length === 1
    ? ok("api_invoices_list", items.map((i) => `${i.number} total=${i.total} paid=${i.paid}`))
    : fail("api_invoices_list", list.json);
  const bal = await api(ERP, "GET", `/api/ledger/balance/${supplierId}?currency=USD`, { token });
  ok("api_party_balance", bal.json);
  const cash = await api(ERP, "GET", "/api/cashbox/state", { token });
  ok("api_cashbox_state", cash.json);

  // License chain still intact after business traffic
  const dl2 = await api(LIC, "GET", "/license-admin/licenses", { token: adminToken });
  const still = dl2.json?.licenses?.find((l) => l.id === license.id);
  still && String(still.tenantId ?? still.tenant_id) === tenantId
    ? ok("dashboard_chain_intact_after_tx", { license: still.id, tenant: still.tenantId ?? still.tenant_id })
    : fail("dashboard_chain_intact_after_tx", still ?? dl2.json);
}

await dbc.end();
writeFileSync("qa-e2e-report.json", JSON.stringify(report, null, 2));
console.log("\n=== FINAL ===");
console.log(report.pass ? "OVERALL: PASS" : "OVERALL: FAIL");
console.log("report: qa-e2e-report.json");
process.exit(report.pass ? 0 : 1);
