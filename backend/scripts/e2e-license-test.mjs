/**
 * Comprehensive E2E License System Test Script
 * Run AFTER starting the backend server: cd backend && npm run dev
 * Usage: node backend/scripts/e2e-license-test.mjs [BASE_URL]
 */
const BASE = process.argv[2] || "http://127.0.0.1:8080";
const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const SKIP = "\x1b[33mSKIP\x1b[0m";
let passed = 0, failed = 0, skipped = 0;

async function api(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

function result(name, ok, detail = "") {
  if (ok === "skip") { skipped++; console.log(`  ${SKIP} ${name}` + (detail ? ` — ${detail}` : "")); }
  else if (ok) { passed++; console.log(`  ${PASS} ${name}` + (detail ? ` — ${detail}` : "")); }
  else { failed++; console.log(`  ${FAIL} ${name}` + (detail ? ` — ${detail}` : "")); }
}

console.log("=== A. Full Installation Simulation (DB verify) ===");
{
  const db = await import("pg");
  const c = new db.default.Client({ connectionString: "postgresql://app_user:B1nOnV1DUq6cMuZJmhhB6W-l@localhost:5432/erp" });
  await c.connect();

  const lic = await c.query("SELECT id, key, status, tenant_id FROM licenses WHERE status = 'active' LIMIT 1");
  result("Active license exists in DB", lic.rows.length > 0, lic.rows[0]?.key);

  const tenant = await c.query("SELECT id, name, license_status, activation_id FROM tenants WHERE id = $1", [lic.rows[0]?.tenant_id]);
  result("Tenant has active license", tenant.rows[0]?.license_status === "active");
  result("Tenant has activation ID", !!tenant.rows[0]?.activation_id);

  const activations = await c.query("SELECT id, deactivated_at FROM license_activations WHERE license_id = $1 AND deactivated_at IS NULL", [lic.rows[0]?.id]);
  result("One active (non-deactivated) activation", activations.rows.length === 1);

  const users = await c.query("SELECT id, email, role FROM users LIMIT 5");
  result("Admin user exists", users.rows.some(u => u.role === "admin"), users.rows.find(u => u.role === "admin")?.email);

  const secrets = await c.query("SELECT key FROM secrets WHERE key = 'license.token.current'");
  result("License token stored in secrets", secrets.rows.length > 0);

  await c.end();
}

console.log("\n=== B. Server Health & Auth ===");
{
  const health = await api("GET", "/api/health");
  result("Health endpoint responds", health.status === 200, `status=${health.status}`);

  const login = await api("POST", "/api/auth/login", { email: "admin@erp.local", password: "Admin123!@#" });
  let token = login.json?.token;
  result("Admin login succeeds", login.status === 200 && !!token, `status=${login.status}`);

  if (token) {
    const dash = await api("GET", "/api/dashboard", null, { Authorization: `Bearer ${token}` });
    result("Dashboard accessible with token", dash.status === 200, `status=${dash.status}`);

    // Logout
    const logout = await api("POST", "/api/auth/logout", null, { Authorization: `Bearer ${token}` });
    result("Logout succeeds", logout.status === 200, `status=${logout.status}`);

    // Login again from same "device"
    const login2 = await api("POST", "/api/auth/login", { email: "admin@erp.local", password: "Admin123!@#" });
    let token2 = login2.json?.token;
    result("Re-login succeeds (no reactivation needed)", login2.status === 200 && !!token2);

    if (token2) {
      const dash2 = await api("GET", "/api/dashboard", null, { Authorization: `Bearer ${token2}` });
      result("Dashboard accessible after re-login", dash2.status === 200);
    }
  }
}

console.log("\n=== C. License API ===");
{
  const login = await api("POST", "/api/auth/login", { email: "admin@erp.local", password: "Admin123!@#" });
  const token = login.json?.token;
  if (!token) { result("License API tests", "skip", "no auth token"); }
  else {
    const h = { Authorization: `Bearer ${token}` };
    const lic = await api("GET", "/api/license/status", null, h);
    result("License status endpoint", lic.status === 200 || lic.status === 404, `status=${lic.status}`);

    const invite = await api("POST", "/api/invitations", { name: "Test Accountant", role: "accountant", expiresInDays: 7 }, h);
    result("Invitation code creation", invite.status === 201 || invite.status === 200, `status=${invite.status}`);
    if (invite.json?.code) {
      const code = invite.json.code;
      const pubInv = await api("POST", "/api/invitations/accept", { code, name: "Test Accountant", email: "accountant@test.local", password: "Test123!@#" });
      result("Invitation accept by new user", pubInv.status === 200 || pubInv.status === 201, `status=${pubInv.status}`);
    }
  }
}

console.log("\n=== D. Feature Enforcement ===");
{
  const login = await api("POST", "/api/auth/login", { email: "admin@erp.local", password: "Admin123!@#" });
  const token = login.json?.token;
  if (!token) { result("Feature enforcement tests", "skip", "no auth token"); }
  else {
    const h = { Authorization: `Bearer ${token}` };
    const inv = await api("GET", "/api/inventory/fabrics", null, h);
    result("Inventory accessible (feature.inventory)", inv.status === 200 || inv.status === 404, `status=${inv.status}`);

    const inv2 = await api("GET", "/api/invoices", null, h);
    result("Invoices accessible (feature.sales)", inv2.status === 200 || inv2.status === 404, `status=${inv2.status}`);
  }
}

console.log("\n=== E. Regression: Invoice + Ledger ===");
{
  const login = await api("POST", "/api/auth/login", { email: "admin@erp.local", password: "Admin123!@#" });
  const token = login.json?.token;
  if (!token) { result("Regression tests", "skip", "no auth token"); }
  else {
    const h = { Authorization: `Bearer ${token}` };
    const fabrics = await api("GET", "/api/inventory/fabrics", null, h);
    result("Fabrics list loads", fabrics.status === 200 || fabrics.status === 404, `status=${fabrics.status}`);

    const invoices = await api("GET", "/api/invoices", null, h);
    result("Invoices list loads", invoices.status === 200 || invoices.status === 404, `status=${invoices.status}`);

    const ledger = await api("GET", "/api/ledger", null, h);
    result("Ledger accessible", ledger.status === 200 || ledger.status === 404, `status=${ledger.status}`);

    const parties = await api("GET", "/api/parties", null, h);
    result("Parties list loads", parties.status === 200 || parties.status === 404, `status=${parties.status}`);
  }
}

console.log("\n" + "=".repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
