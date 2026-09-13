/**
 * Batch 4 — authentication, device trust and authorization on the sync surface.
 *
 * REAL HTTP ATTACK DRILL. One real backend process (the hub) on a database
 * cloned from the migrated `sync_tpl` template, real JWTs, two tenants. Every
 * check prints the actual HTTP status and response body it observed, so the
 * report can quote reproductions instead of code readings.
 *
 * What is attacked:
 *   A. /sync/* role matrix        — each endpoint with an under-privileged role
 *      and the counterfactual with a role that is allowed.
 *   B. Forged device id           — a valid session asserting ANOTHER user's
 *      registered device id, and an id this tenant never registered.
 *   C. Cross-tenant operation     — a T2 token asserting a T1 device id, and a
 *      T1 push carrying a T2 tenant hint.
 *   D. Forged actor role          — a payload claiming actorRole "admin" /
 *      another actorUserId, plus a token whose role claim no longer matches the
 *      user's DB role (demotion), plus a deactivated user holding a live token.
 *   E. Revoked device             — push / pull / register after revocation, and
 *      the reinstate counterfactual. Verifies the local outbox is preserved
 *      (the unit stays `pending`, never `rejected`).
 *   F. Device-roster disclosure   — anonymous enumeration of a tenant's users,
 *      cross-tenant enumeration, and the provisioning-credential paths that
 *      keep the desktop PIN picker working.
 *   G. Master delete base version — a stale delete replay vs a newer hub edit,
 *      the tombstone (no resurrection), and a legitimate new-id re-creation.
 *
 * Usage:  node scripts/verify-batch4-device-trust.mjs [--keep] [--refresh-template]
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const BACKEND = path.resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");
const PG = { host: "localhost", port: 5432, user: "postgres", password: "postgres" };

const T1 = "aaaaaaaa-1111-4111-8111-111111111111";
const T2 = "bbbbbbbb-2222-4222-8222-222222222222";
const U_ADMIN = "a0000000-0000-4000-8000-000000000001";
const U_ACCT = "a0000000-0000-4000-8000-000000000002";
const U_VIEWER = "a0000000-0000-4000-8000-000000000003";
const U_WARE = "a0000000-0000-4000-8000-000000000004";
const U_INACTIVE = "a0000000-0000-4000-8000-000000000005";
const U_ADMIN2 = "a0000000-0000-4000-8000-000000000006";
const U_T2 = "b0000000-0000-4000-8000-000000000001";

const DEV_ADMIN = "d0000000-0000-4000-8000-000000000001"; // bound to U_ADMIN
const DEV_ADMIN2 = "d0000000-0000-4000-8000-000000000002"; // bound to U_ADMIN
const DEV_WARE = "d0000000-0000-4000-8000-000000000003"; // bound to U_WARE
const DEV_T2 = "d0000000-0000-4000-8000-000000000004"; // T2, bound to U_T2
const DEV_VIEWER = "d0000000-0000-4000-8000-000000000005"; // bound to U_VIEWER

const FP_ADMIN = "fp-admin-batch4-0000000000000001";
const FP_ADMIN2 = "fp-admin2-batch4-000000000000001";
const FP_WARE = "fp-warehouse-batch4-00000000001";
const FP_T2 = "fp-tenant2-batch4-00000000000001";
const FP_VIEWER = "fp-viewer-batch4-000000000000001";
const FP_REVOKED_REG = "fp-revoked-registration-000000001";

const LICENSE_T1 = "c0000000-0000-4000-8000-000000000001";
const ACTIVATION_T1 = "e0000000-0000-4000-8000-000000000001";
const LICENSE_T2 = "c0000000-0000-4000-8000-000000000002";
const ACTIVATION_T2 = "e0000000-0000-4000-8000-000000000002";

const HUB = { db: "batch4_hub", port: 8097 };
const TEMPLATE_DB = "sync_tpl";

const results = [];
let server = null;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
/** Record an observed HTTP exchange as evidence in the log. */
function observe(label, status, body) {
  const compact = body === undefined ? "" : JSON.stringify(body).slice(0, 220);
  console.log(`  · ${label}: HTTP ${status} ${compact}`);
  return { status, body };
}

// ------------------------------------------------------------------ env

function loadEnv() {
  const env = {};
  for (const file of ["../.env", ".env"]) {
    const p = path.resolve(BACKEND, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return env;
}
const BASE_ENV = loadEnv();
const dbUrl = (db) => `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;

async function adminClient() {
  const c = new pg.Client({ ...PG, database: "postgres" });
  await c.connect();
  return c;
}
async function hubClient() {
  const c = new pg.Client({ ...PG, database: HUB.db });
  await c.connect();
  return c;
}

// ------------------------------------------------------------------ template

async function ensureTemplate() {
  const refresh = process.argv.includes("--refresh-template");
  const c = await adminClient();
  const exists = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB]);
  if (exists.rows.length > 0 && !refresh) {
    const probe = new pg.Client({ ...PG, database: TEMPLATE_DB });
    await probe.connect();
    const cols = await probe.query(
      `SELECT count(*)::int AS c FROM information_schema.columns
        WHERE table_name='sync_devices'
          AND column_name IN ('revoked_at','revoke_reason','authorized_user_ids')`,
    );
    await probe.end();
    await c.end();
    if (cols.rows[0].c === 3) {
      console.log(`  template ${TEMPLATE_DB} reused (device-trust columns present)`);
      return;
    }
    console.log(`  template ${TEMPLATE_DB} is stale (Batch 4 columns missing) — rebuilding`);
    const c2 = await adminClient();
    await c2.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c2.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    await c2.end();
  } else {
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    await c.end();
  }
  console.log(`  migrating template ${TEMPLATE_DB} (slow part, ~2 min)…`);
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    ["node_modules/drizzle-kit/bin.cjs", "migrate"],
    {
      cwd: BACKEND,
      env: { ...process.env, ...BASE_ENV, DATABASE_URL: dbUrl(TEMPLATE_DB), ADMIN_DATABASE_URL: dbUrl(TEMPLATE_DB) },
      stdio: "inherit",
    },
  );
  console.log("  template ready");
}

async function cloneHub() {
  const c = await adminClient();
  await c.query(`DROP DATABASE IF EXISTS "${HUB.db}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${HUB.db}" TEMPLATE "${TEMPLATE_DB}"`);
  await c.end();
}

// ------------------------------------------------------------------ seed

async function seed() {
  const c = await hubClient();
  for (const [id, name, slug] of [
    [T1, "Batch4 Tenant One", "batch4-t1"],
    [T2, "Batch4 Tenant Two", "batch4-t2"],
  ]) {
    await c.query(
      `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
       VALUES ($1, $2, $3, 'active', 'no_license', 'trial') ON CONFLICT (id) DO NOTHING`,
      [id, name, slug],
    );
    await c.query(
      `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
       VALUES ($1, 'done', ARRAY['welcome'], true, now())
       ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done'`,
      [id],
    );
  }
  const users = [
    [U_ADMIN, T1, "admin@b4.local", "admin", true],
    [U_ACCT, T1, "acct@b4.local", "accountant", true],
    [U_VIEWER, T1, "viewer@b4.local", "viewer", true],
    [U_WARE, T1, "ware@b4.local", "warehouse", true],
    [U_INACTIVE, T1, "inactive@b4.local", "admin", false],
    [U_ADMIN2, T1, "admin2@b4.local", "admin", true],
    [U_T2, T2, "admin@b4t2.local", "admin", true],
  ];
  for (const [id, tenant, email, role, active] of users) {
    await c.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, 'not-used', $5, $6) ON CONFLICT (id) DO NOTHING`,
      [id, tenant, email.split("@")[0], email, role, active],
    );
  }
  const devices = [
    // Batch 4 / 4B: an API-registered device is bound to the user who
    // registered it (authorized_user_ids) — the drill emulates that row.
    [DEV_ADMIN, T1, FP_ADMIN, "device-admin", U_ADMIN],
    [DEV_ADMIN2, T1, FP_ADMIN2, "device-admin2", U_ADMIN],
    [DEV_WARE, T1, FP_WARE, "device-warehouse", U_WARE],
    [DEV_T2, T2, FP_T2, "device-t2", U_T2],
    // Bound to the read-only viewer/user: proves the TRANSPORT endpoints
    // (push/pull) are device-gated, not role-gated — a viewer session can
    // still flush work that a route guard already authorized locally.
    [DEV_VIEWER, T1, FP_VIEWER, "device-viewer", U_VIEWER],
  ];
  for (const [id, tenant, fp, label, owner] of devices) {
    await c.query(
      `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                                 last_seen_by_user_id, authorized_user_ids)
       VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])
       ON CONFLICT (id) DO NOTHING`,
      [id, tenant, fp, label, owner],
    );
  }
  // Licenses + activations (for the 4C provisioning-credential paths).
  // `features` must cover inventory — the drill creates fabrics through the
  // real REST route, which sits behind `requireFeature(FEATURES.INVENTORY)`.
  // A license row without features would 403 the create for the wrong reason.
  for (const [licId, tenant, key, actId] of [
    [LICENSE_T1, T1, "BATCH4-T1-LICENSE", ACTIVATION_T1],
    [LICENSE_T2, T2, "BATCH4-T2-LICENSE", ACTIVATION_T2],
  ]) {
    await c.query(
      `INSERT INTO licenses (id, key, type, status, tenant_id, features)
       VALUES ($1, $2, 'full', 'active', $3, ARRAY['feature.inventory']::text[])
       ON CONFLICT (id) DO NOTHING`,
      [licId, key, tenant],
    );
    await c.query(
      `INSERT INTO license_activations (id, license_id, tenant_id, server_fingerprint)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [actId, licId, tenant, `server-fp-${tenant.slice(0, 8)}`],
    );
  }
  // Device registrations: one live (invite-provisioned device fingerprint),
  // one revoked (must NOT pass the same check).
  await c.query(
    `INSERT INTO device_registrations (license_id, tenant_id, device_id, device_fingerprint, platform, name)
     VALUES ($1, $2, gen_random_uuid(), $3, 'windows', 'invite-provisioned')`,
    [LICENSE_T1, T1, FP_WARE],
  );
  await c.query(
    `INSERT INTO device_registrations (license_id, tenant_id, device_id, device_fingerprint, platform, name, revoked_at, revoke_reason)
     VALUES ($1, $2, gen_random_uuid(), $3, 'windows', 'revoked-device', now(), 'stolen')`,
    [LICENSE_T1, T1, FP_REVOKED_REG],
  );
  await c.end();
}

// ------------------------------------------------------------------ server

function startHub() {
  const out = fs.openSync(path.join(BACKEND, "batch4-hub.log"), "w");
  const env = {
    ...process.env,
    ...BASE_ENV,
    DATABASE_URL: dbUrl(HUB.db),
    PORT: String(HUB.port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    RATE_LIMIT_RPS: "100000",
  };
  delete env.CENTRAL_SYNC_URL;
  delete env.DESKTOP_DEPLOY;
  delete env.BOOTSTRAP_TENANT_ID;
  server = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/presentation/server.ts"],
    { cwd: BACKEND, env, stdio: ["ignore", out, out] },
  );
}

async function waitForHealth(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HUB.port}/api/health/live`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`hub not healthy (${last})`);
}

async function stopHub() {
  if (!server) return;
  try {
    server.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 800));
}

// ------------------------------------------------------------------ auth / api

async function mint(userId, tenantId, role) {
  const secret = new TextEncoder().encode(BASE_ENV.JWT_SECRET);
  return new SignJWT({ sub: userId, tenantId, role, jti: randomUUID(), type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

const TOKENS = {};

async function api(method, urlPath, { token, deviceId, body, headers = {} } = {}) {
  // All app routes live under `/api` (app.use("/api", apiRouter)). The drill
  // spells sync/inventory paths without the prefix for readability — normalize
  // here so every probe hits the real mounted route, never the 404 catch-all.
  const path = urlPath.startsWith("/api/") ? urlPath : `/api${urlPath}`;
  const res = await fetch(`http://127.0.0.1:${HUB.port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, body: json };
}

function pushUnit(deviceId, entityType, entityId, operation, payload, opId = randomUUID()) {
  return { opId, syncDeviceId: deviceId, entityType, entityId, operation, payload };
}

// ------------------------------------------------------------------ checks

async function main() {
  console.log("Batch 4 — device trust & authorization attack drill");
  section("Setup");
  await ensureTemplate();
  await cloneHub();
  await seed();
  startHub();
  await waitForHealth();
  console.log(`  hub listening on 127.0.0.1:${HUB.port} (db ${HUB.db})`);

  TOKENS.admin = await mint(U_ADMIN, T1, "admin");
  TOKENS.acct = await mint(U_ACCT, T1, "accountant");
  TOKENS.viewer = await mint(U_VIEWER, T1, "viewer");
  TOKENS.ware = await mint(U_WARE, T1, "warehouse");
  TOKENS.t2 = await mint(U_T2, T2, "admin");
  // A token minted for an account that has since been demoted/deactivated:
  // the claim inside it is stale, and the hub must not honour it.
  TOKENS.viewerWithAdminClaim = await mint(U_VIEWER, T1, "admin");
  TOKENS.inactiveAdmin = await mint(U_INACTIVE, T1, "admin");

  /* ---------------- A. RBAC matrix on /sync/* ---------------- */
  section("A. RBAC matrix — under-privileged roles on /sync/*");

  {
    const r = await api("GET", "/sync/status", { token: TOKENS.viewer });
    observe("viewer GET /sync/status", r.status, r.body);
    check("A1 read diagnostics allowed for viewer", r.status === 200);
  }
  {
    const r = await api("POST", "/sync/claims/reap", { token: TOKENS.viewer });
    observe("viewer POST /sync/claims/reap", r.status, r.body);
    check("A2 viewer denied claims repair", r.status === 403 && r.body?.code === "FORBIDDEN");
  }
  {
    const r = await api("POST", "/sync/claims/reap", { token: TOKENS.acct });
    observe("accountant POST /sync/claims/reap", r.status, r.body);
    check("A3 accountant denied claims repair (admin-only operator action)", r.status === 403);
  }
  {
    const r = await api("POST", "/sync/claims/reap", { token: TOKENS.admin });
    observe("admin POST /sync/claims/reap", r.status, r.body);
    check("A4 admin allowed claims repair (counterfactual)", r.status === 200);
  }
  {
    const r = await api("POST", "/sync/conflicts/resolve", {
      token: TOKENS.viewer,
      body: { conflictId: randomUUID(), decision: "withdraw" },
    });
    observe("viewer POST /sync/conflicts/resolve", r.status, r.body);
    check("A5 viewer denied conflict resolution", r.status === 403 && r.body?.code === "FORBIDDEN");
  }
  {
    const r = await api("POST", "/sync/conflicts/resolve", {
      token: TOKENS.ware,
      body: { conflictId: randomUUID(), decision: "withdraw" },
    });
    observe("warehouse POST /sync/conflicts/resolve", r.status, r.body);
    check(
      "A6 warehouse passes the conflict guard (unknown conflict → 409)",
      r.status === 409 && r.body?.code === "SYNC_CONFLICT_NOT_OPEN",
    );
  }
  {
    const r = await api("POST", "/sync/number-blocks/claim", {
      token: TOKENS.viewer,
      deviceId: DEV_WARE,
      body: { syncDeviceId: DEV_WARE, entityType: "invoice" },
    });
    observe("viewer POST /sync/number-blocks/claim", r.status, r.body);
    check("A7 viewer denied number-block minting", r.status === 403 && r.body?.code === "FORBIDDEN");
  }
  {
    const r = await api("POST", "/sync/number-blocks/claim", {
      token: TOKENS.ware,
      deviceId: DEV_WARE,
      body: { syncDeviceId: DEV_WARE, entityType: "invoice" },
    });
    observe("warehouse POST /sync/number-blocks/claim", r.status, r.body);
    check(
      "A8 warehouse allowed number-block minting on its own device",
      r.status === 201,
      JSON.stringify(r.body).slice(0, 120),
    );
  }
  {
    const r = await api("POST", "/sync/run", { token: TOKENS.viewer, deviceId: DEV_ADMIN });
    observe("viewer POST /sync/run (transport, foreign device)", r.status, r.body);
    check("A9 viewer keeps the device transport (offline flow intact)", r.status === 200);
  }
  {
    const r = await api("POST", `/sync/devices/${DEV_ADMIN}/revoke`, { token: TOKENS.ware });
    observe("warehouse POST /sync/devices/:id/revoke", r.status, r.body);
    check("A10 warehouse denied device revocation", r.status === 403 && r.body?.code === "FORBIDDEN");
  }
  {
    const r = await api("GET", "/sync/devices", { token: TOKENS.acct });
    observe("accountant GET /sync/devices", r.status, r.body);
    check("A11 device inventory is admin-only", r.status === 403);
  }
  {
    const r = await api("GET", "/sync/devices", { token: TOKENS.admin });
    observe("admin GET /sync/devices", r.status, r.body);
    check(
      "A12 admin reads the device inventory",
      r.status === 200 && (r.body?.items ?? []).length >= 3,
    );
  }
  {
    const r = await api("GET", "/sync/status", {});
    observe("anonymous GET /sync/status", r.status, r.body);
    check("A13 anonymous sync access still refused", r.status === 401);
  }

  // A14+ — exhaustive per-endpoint sweep: EVERY /sync/* endpoint is hit with
  // the least-privileged role that the matrix claims covers or excludes it.
  // Read diagnostics and device transport admit every role BY DESIGN (reads
  // mirror dashboard/audit; transport authority is the device gate, not the
  // pusher's role — restricting it would strand shared workstations' queues).
  // Operator/numbering endpoints must 403 every non-allowed role.
  section("A14-A26. Per-endpoint role sweep (all /sync/* endpoints)");
  {
    // Read diagnostics — viewer is the least-privileged role; all must pass.
    for (const [path, label] of [
      ["/sync/inbox", "inbox triage"],
      ["/sync/pending", "pending outbox"],
      ["/sync/claims", "claim inventory"],
      ["/sync/conflicts", "conflict list"],
      ["/sync/number-blocks?syncDeviceId=" + DEV_VIEWER, "number-block read"],
    ]) {
      const r = await api("GET", path, { token: TOKENS.viewer });
      observe(`viewer GET ${path}`, r.status, r.body);
      check(`A14 read diagnostics open to viewer: ${label}`, r.status === 200);
    }
    // Device transport — viewer with its OWN bound device must reach push and
    // pull (offline flow of a read-only workstation user stays intact).
    {
      const partyId = randomUUID();
      const r = await api("POST", "/sync/push", {
        token: TOKENS.viewer,
        deviceId: DEV_VIEWER,
        body: pushUnit(DEV_VIEWER, "party", partyId, "create", {
          snapshot: { id: partyId, name: "Viewer Transport Party", kind: "customer" },
        }),
      });
      observe("viewer POST /sync/push (own bound device)", r.status, r.body);
      check(
        "A15 transport is device-gated, not role-gated: viewer pushes on its own device",
        r.status === 201,
      );
    }
    {
      const r = await api("GET", "/sync/pull?limit=5", { token: TOKENS.viewer });
      observe("viewer GET /sync/pull (no device asserted)", r.status, r.body);
      check("A16 pull transport open to viewer (unattributed)", r.status === 200);
    }
    // Numbering — warehouse allowed (counterfactual), viewer excluded.
    {
      const r = await api("POST", "/sync/number-blocks/ensure", {
        token: TOKENS.viewer,
        deviceId: DEV_VIEWER,
        body: { syncDeviceId: DEV_VIEWER },
      });
      observe("viewer POST /sync/number-blocks/ensure", r.status, r.body);
      check("A17 viewer denied number-block ensure", r.status === 403 && r.body?.code === "FORBIDDEN");
    }
    {
      const r = await api("POST", "/sync/number-blocks/ensure", {
        token: TOKENS.ware,
        deviceId: DEV_WARE,
        body: { syncDeviceId: DEV_WARE },
      });
      observe("warehouse POST /sync/number-blocks/ensure", r.status, r.body);
      check("A18 warehouse allowed number-block ensure (counterfactual)", r.status === 200);
    }
    // Device lifecycle + repairs — admin-only: every other role refused.
    for (const [role, token] of [
      ["viewer", TOKENS.viewer],
      ["accountant", TOKENS.acct],
      ["warehouse", TOKENS.ware],
    ]) {
      const r = await api("POST", `/sync/devices/${DEV_ADMIN}/revoke`, { token });
      observe(`${role} POST /sync/devices/:id/revoke`, r.status, r.body);
      check(`A19 ${role} denied device revocation`, r.status === 403 && r.body?.code === "FORBIDDEN");
    }
    for (const [role, token] of [
      ["viewer", TOKENS.viewer],
      ["accountant", TOKENS.acct],
      ["warehouse", TOKENS.ware],
    ]) {
      const r = await api("POST", `/sync/devices/${DEV_ADMIN}/reinstate`, { token });
      observe(`${role} POST /sync/devices/:id/reinstate`, r.status, r.body);
      check(`A20 ${role} denied device reinstatement`, r.status === 403 && r.body?.code === "FORBIDDEN");
    }
    {
      const r = await api("POST", "/sync/number-blocks/reclaim", {
        token: TOKENS.viewer,
        body: { blockId: randomUUID() },
      });
      observe("viewer POST /sync/number-blocks/reclaim", r.status, r.body);
      check("A21 viewer denied number-block reclaim", r.status === 403 && r.body?.code === "FORBIDDEN");
    }
    {
      const r = await api("POST", "/sync/number-blocks/reclaim", {
        token: TOKENS.ware,
        body: { blockId: randomUUID() },
      });
      observe("warehouse POST /sync/number-blocks/reclaim", r.status, r.body);
      check("A22 warehouse denied number-block reclaim (admin-only)", r.status === 403);
    }
    {
      const r = await api("POST", "/sync/claims/reap", { token: TOKENS.ware });
      observe("warehouse POST /sync/claims/reap", r.status, r.body);
      check("A23 warehouse denied claims reap (admin-only)", r.status === 403);
    }
    {
      const r = await api("POST", "/sync/conflicts/resolve", {
        token: TOKENS.acct,
        body: { conflictId: randomUUID(), decision: "keep-server" },
      });
      observe("accountant POST /sync/conflicts/resolve", r.status, r.body);
      check(
        "A24 accountant passes the conflict guard (unknown conflict → 409)",
        r.status === 409 && r.body?.code === "SYNC_CONFLICT_NOT_OPEN",
      );
    }
    {
      const r = await api("GET", "/sync/devices", { token: TOKENS.viewer });
      observe("viewer GET /sync/devices", r.status, r.body);
      check("A25 viewer denied device inventory", r.status === 403);
    }
    {
      const r = await api("GET", "/sync/status", { token: TOKENS.ware });
      observe("warehouse GET /sync/status", r.status, r.body);
      check("A26 warehouse reads sync status (counterfactual)", r.status === 200);
    }
  }

  /* ---------------- B. forged device id / C. cross-tenant ---------------- */
  section("B/C. Forged device id and cross-tenant operations");

  {
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.acct,
      body: pushUnit(DEV_ADMIN, "party", partyId, "create", {
        snapshot: { id: partyId, name: "Forged Actor Party", kind: "customer" },
        actorUserId: U_ADMIN,
        actorRole: "admin",
      }),
    });
    observe("accountant pushes as another user's device D1", r.status, r.body);
    check(
      "B1 a device bound to another user is refused (forged device id)",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_NOT_BOUND",
    );
  }
  {
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.acct,
      body: pushUnit(randomUUID(), "party", partyId, "create", {
        snapshot: { id: partyId, name: "Unknown Device Party", kind: "customer" },
      }),
    });
    observe("accountant pushes with an unregistered device id", r.status, r.body);
    check(
      "B2 unregistered device id refused",
      r.status === 403 && r.body?.code === "SYNC_UNKNOWN_DEVICE",
    );
  }
  {
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.t2,
      body: pushUnit(DEV_ADMIN, "party", partyId, "create", {
        snapshot: { id: partyId, name: "Cross Tenant Party", kind: "customer" },
      }),
    });
    observe("T2 token pushes with a T1 device id", r.status, r.body);
    check(
      "C1 cross-tenant device id refused (tenant-scoped lookup)",
      r.status === 403 && r.body?.code === "SYNC_UNKNOWN_DEVICE",
    );
  }
  {
    // tenantId in the body must be ignored: the tenant comes from the JWT.
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.t2,
      body: {
        ...pushUnit(DEV_T2, "party", partyId, "create", {
          snapshot: { id: partyId, name: "Tenant Hint Party", kind: "customer" },
        }),
        tenantId: T1,
      },
    });
    observe("T2 token pushes with tenantId=T1 in the body", r.status, r.body);
    const c = await hubClient();
    const row = await c.query(`SELECT tenant_id FROM parties WHERE id = $1`, [partyId]);
    await c.end();
    check(
      "C2 body tenantId is ignored — the row lands in the token's tenant (T2)",
      r.status === 201 && row.rows[0]?.tenant_id === T2,
      `row tenant=${row.rows[0]?.tenant_id ?? "none"}`,
    );
  }
  {
    const r = await api("GET", `/sync/pull?excludeSyncDeviceId=${DEV_ADMIN}&limit=5`, {
      token: TOKENS.acct,
    });
    observe("accountant pulls excluding another user's device", r.status, r.body);
    check(
      "C3 pull asserting another user's device is refused",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_NOT_BOUND",
    );
  }

  /* ---------------- D. forged actor role / revoked user ---------------- */
  section("D. Forged actor role and revoked user");

  {
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.viewer,
      deviceId: DEV_WARE, // bound to U_WARE, not to the viewer
      body: pushUnit(
        DEV_WARE,
        "party",
        partyId,
        "create",
        {
          snapshot: { id: partyId, name: "Actor Claim Party", kind: "customer" },
          actorUserId: U_ADMIN,
          actorRole: "admin",
        },
        randomUUID(),
      ),
    });
    observe("viewer authenticates, payload claims actorRole=admin", r.status, r.body);
    // The viewer is not bound to DEV_WARE → the device gate refuses first. The
    // actor-forgery question is answered by D2 below (bound device, forged actor).
    check(
      "D1 unbound device refused before any actor claim is considered",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_NOT_BOUND",
    );
  }
  {
    // Forge the actor on a device the pusher IS bound to: U_WARE pushes a unit
    // claiming actorUserId=U_ADMIN / actorRole=admin.
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.ware,
      body: pushUnit(DEV_WARE, "party", partyId, "create", {
        snapshot: { id: partyId, name: "Forged Actor Warehouse", kind: "customer" },
        actorUserId: U_ADMIN,
        actorRole: "admin",
        actorUserName: "admin",
      }),
    });
    observe("warehouse pushes a unit claiming actorRole=admin", r.status, r.body);
    const c = await hubClient();
    const row = await c.query(`SELECT created_by FROM parties WHERE id = $1`, [partyId]);
    await c.end();
    check(
      "D2 materialization uses the AUTHENTICATED receiver, not the claimed actor",
      r.status === 201 && row.rows[0]?.created_by === U_WARE,
      `created_by=${row.rows[0]?.created_by ?? "none"}`,
    );
  }
  {
    // A token whose role claim says admin, for a user the DB says is a viewer.
    const r = await api("POST", "/sync/claims/reap", { token: TOKENS.viewerWithAdminClaim });
    observe("demoted user's old admin-claim token → /sync/claims/reap", r.status, r.body);
    check(
      "D3 stale role claim in the token does not grant admin",
      r.status === 403 && r.body?.code === "FORBIDDEN",
    );
  }
  {
    const r = await api("GET", "/sync/status", { token: TOKENS.inactiveAdmin });
    observe("deactivated user's live token → /sync/status", r.status, r.body);
    check(
      "D4 deactivated (revoked) user's live token is refused",
      r.status === 401 && r.body?.code === "TOKEN_EXPIRED",
    );
  }
  {
    const r = await api("POST", "/api/auth/sync-device", {
      token: TOKENS.inactiveAdmin,
      body: { deviceFingerprint: "fp-inactive-user-00000000000001", platform: "windows" },
    });
    observe("deactivated user registers a device", r.status, r.body);
    check("D5 deactivated user cannot bind a device", r.status === 401);
  }
  {
    const r = await api("POST", "/api/auth/sync-device", {
      token: TOKENS.admin,
      body: { deviceFingerprint: FP_ADMIN, platform: "windows", deviceId: DEV_ADMIN },
    });
    observe("re-register own device with matching fingerprint", r.status, r.body);
    check("D6 matching fingerprint re-registration succeeds", r.status === 200);
  }
  {
    // Registration-side device-id takeover: a DIFFERENT user announces U_ADMIN's
    // registered device id with a DIFFERENT fingerprint. Possession of the
    // physical device cannot be proven, so the id must not be adopted — this is
    // exactly the pre-Batch-4 hole where registerOrTouch overwrote the stored
    // fingerprint from input.
    const r = await api("POST", "/api/auth/sync-device", {
      token: TOKENS.ware,
      body: {
        deviceFingerprint: "fp-attacker-warehouse-0000000000001",
        platform: "windows",
        deviceId: DEV_ADMIN,
      },
    });
    observe("warehouse re-announces U_ADMIN's device id with its own fingerprint", r.status, r.body);
    check(
      "D7 a registered device id cannot be taken over with a non-matching fingerprint",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_FINGERPRINT_MISMATCH",
    );
  }

  /* ---------------- E. revoked device ---------------- */
  section("E. Revoked device");

  const preRevokeParty = randomUUID();
  const beforeRevoke = await api("POST", "/sync/push", {
    token: TOKENS.admin,
    body: pushUnit(DEV_ADMIN2, "party", preRevokeParty, "create", {
      snapshot: { id: preRevokeParty, name: "Pre-Revoke Party", kind: "customer" },
    }),
  });
  observe("push on DEV_ADMIN2 before revocation", beforeRevoke.status, beforeRevoke.body);
  check(
    "E0 the same device pushes successfully BEFORE revocation (counterfactual)",
    beforeRevoke.status === 201,
  );

  {
    const r = await api("POST", `/sync/devices/${DEV_ADMIN2}/revoke`, {
      token: TOKENS.admin,
      body: { reason: "lost_in_field" },
    });
    observe("admin revokes DEV_ADMIN2", r.status, r.body);
    check("E1 revocation succeeds", r.status === 200 && r.body?.ok === true);
  }
  {
    const partyId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(DEV_ADMIN2, "party", partyId, "create", {
        snapshot: { id: partyId, name: "Post-Revoke Party", kind: "customer" },
      }),
    });
    observe("push on the revoked device", r.status, r.body);
    check(
      "E2 revoked device cannot push",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_REVOKED",
    );
  }
  {
    const r = await api("GET", `/sync/pull?excludeSyncDeviceId=${DEV_ADMIN2}&limit=5`, {
      token: TOKENS.admin,
    });
    observe("pull on the revoked device", r.status, r.body);
    check(
      "E3 revoked device cannot pull",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_REVOKED",
    );
  }
  {
    const r = await api("POST", "/api/auth/sync-device", {
      token: TOKENS.admin,
      body: { deviceFingerprint: FP_ADMIN2, platform: "windows", deviceId: DEV_ADMIN2 },
    });
    observe("revoked device tries to re-register itself", r.status, r.body);
    check(
      "E4 revoked device cannot re-register",
      r.status === 403 && r.body?.code === "SYNC_DEVICE_REVOKED",
    );
  }
  {
    // Offline story, hub-side evidence: the post-revoke attempts (E2 push,
    // E3 pull) must never have entered the sync pipeline at all — the gate
    // refuses BEFORE inbox.receive — while the pre-revoke push (E0) is there
    // and applied. Client-side preservation of the outbox queue on a 403
    // device-trust refusal is asserted by the unit tests
    // (tests/sync-device-trust.test.ts: resetToPending, never markRejected).
    const c = await hubClient();
    const devRows = await c.query(
      `SELECT status, count(*)::int AS c FROM sync_inbox
        WHERE sync_device_id = $1 GROUP BY status`,
      [DEV_ADMIN2],
    );
    const rejected = await c.query(
      `SELECT count(*)::int AS c FROM sync_inbox WHERE status = 'rejected'`,
    );
    await c.end();
    const applied = devRows.rows.find((x) => x.status === "applied")?.c ?? 0;
    check(
      "E5 revoked-device requests never enter the pipeline; pre-revoke unit intact",
      applied === 1 && rejected.rows[0].c === 0,
      `DEV_ADMIN2 inbox rows: applied=${applied}; total rejected=${rejected.rows[0].c}`,
    );
  }
  {
    const r = await api("POST", `/sync/devices/${DEV_ADMIN2}/reinstate`, { token: TOKENS.admin });
    observe("admin reinstates DEV_ADMIN2", r.status, r.body);
    const after = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(DEV_ADMIN2, "party", randomUUID(), "create", {
        snapshot: { id: randomUUID(), name: "Reinstated Party", kind: "customer" },
      }),
    });
    observe("push after reinstatement", after.status, after.body);
    check(
      "E6 reinstatement restores the device (the guard was the only blocker)",
      r.status === 200 && after.status === 201,
    );
  }

  /* ---------------- F. device roster disclosure ---------------- */
  section("F. /api/auth/device-roster disclosure");

  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`);
    observe("anonymous roster (no credential)", r.status, r.body);
    check(
      "F1 anonymous caller gets no user list",
      r.status === 401 && r.body?.code === "DEVICE_PROOF_REQUIRED",
    );
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T2}`);
    observe("anonymous cross-tenant roster (T2)", r.status, r.body);
    check("F2 anonymous caller gets no OTHER tenant's user list", r.status === 401);
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`, { token: TOKENS.admin });
    observe("authenticated roster (admin of T1)", r.status, r.body);
    check(
      "F3 an authenticated session still drives the picker (ACTIVE users only)",
      r.status === 200 && Array.isArray(r.body?.users) && r.body.users.length === 5,
      `users=${r.body?.users?.length ?? 0} (6 seeded, 1 inactive → 5)`,
    );
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`, {
      headers: { "X-Device-Activation-Id": ACTIVATION_T1 },
    });
    observe("roster with the device's activation credential", r.status, r.body);
    check("F4 activation credential path works (desktop/web activation)", r.status === 200);
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`, {
      headers: { "X-Device-Fingerprint": FP_WARE },
    });
    observe("roster with an invite-registered device fingerprint", r.status, r.body);
    check("F5 invite-provisioned device fingerprint path works", r.status === 200);
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`, {
      headers: { "X-Device-Fingerprint": FP_REVOKED_REG },
    });
    observe("roster with a REVOKED registration fingerprint", r.status, r.body);
    check("F6 revoked device registration is not a valid credential", r.status === 401);
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T1}`, {
      headers: { "X-Device-Activation-Id": ACTIVATION_T2 },
    });
    observe("roster for T1 with a T2 activation credential", r.status, r.body);
    check("F7 activation credential is tenant-bound", r.status === 401);
  }
  {
    const r = await api("GET", `/api/auth/device-roster?tenantId=${T2}`, { token: TOKENS.t2 });
    observe("T2 user roster for T2", r.status, r.body);
    check("F8 a tenant-scoped credential still serves its own tenant", r.status === 200);
  }

  /* ---------------- G. master delete base-version discipline ---------------- */
  section("G. Master delete base-version discipline");

  // Mirrors MATERIALIZE_MAX_ATTEMPTS in src/application/use-cases/sync/syncUseCases.ts
  const MATERIALIZE_MAX_ATTEMPTS = 5;
  let fabricId;
  let fabricVersion;
  let staleOpId;
  {
    const r = await api("POST", "/inventory/fabrics", {
      token: TOKENS.admin,
      deviceId: DEV_ADMIN,
      body: { name: "Batch4 Fabric" },
    });
    observe("create fabric", r.status, r.body);
    fabricId = r.body?.id ?? r.body?.data?.id;
    check("G0 fabric created for the delete drill", r.status < 300 && Boolean(fabricId));
  }
  {
    const r = await api("PUT", `/inventory/fabrics/${fabricId}`, {
      token: TOKENS.admin,
      deviceId: DEV_ADMIN,
      body: { name: "Batch4 Fabric v2", expectedVersion: 1 },
    });
    observe("update fabric to v2", r.status, r.body);
    fabricVersion = r.body?.version ?? 2;
    check("G0b fabric at version 2", r.status < 300, `version=${fabricVersion}`);
  }
  {
    // A stale device replays a delete based on v1 while the hub holds v2.
    // NOTE on the HTTP contract: unlike a device-trust refusal (403) or a
    // stock-claim conflict (409 SYNC_CONFLICT, unit rejected), a stale-base
    // loss is RECORDED, not bounced: the hub accepts the unit, refuses to
    // materialize it, files it in `sync_conflicts` for the operator, and
    // leaves it retryable (received → dead after the attempt budget). This is
    // the same discipline as document cancels (refuseStaleCancelBase) and is
    // what tests/sync-device-trust.test.ts asserts at the materialize level.
    staleOpId = randomUUID();
    const r = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(
        DEV_ADMIN,
        "fabric",
        fabricId,
        "delete",
        {
          entityId: fabricId,
          baseVersion: 1,
          actorUserId: U_ADMIN,
          actorRole: "admin",
        },
        staleOpId,
      ),
    });
    observe("stale delete replay (base v1, hub v2)", r.status, r.body);
    const c = await hubClient();
    const row = await c.query(`SELECT version FROM fabrics WHERE id = $1`, [fabricId]);
    const conflict = await c.query(
      `SELECT operation, base_version, server_version, status
         FROM sync_conflicts WHERE tenant_id = $1 AND op_id = $2`,
      [T1, staleOpId],
    );
    await c.end();
    const cf = conflict.rows[0] ?? {};
    check(
      "G1 stale delete is refused: not materialized, conflict recorded, row survives at v2",
      r.status === 201 &&
        r.body?.materialized === false &&
        r.body?.hubStatus === "received" &&
        row.rows.length === 1 &&
        row.rows[0].version === 2 &&
        cf.operation === "cancel" &&
        Number(cf.base_version) === 1 &&
        Number(cf.server_version) === 2 &&
        cf.status === "open",
      `hub version=${row.rows[0]?.version ?? "row gone"}; conflict=${JSON.stringify(cf)}`,
    );
  }
  {
    // Counterfactual: the delete with the CURRENT base applies — but only
    // after the designed reconciliation of the stale unit above:
    //   1. the stale unit holds its first-writer-wins claim on fabric:<id>
    //      while it is `received` — a NEW delete op is REFUSED 409 meanwhile
    //      (that refusal is itself asserted below);
    //   2. re-pushing the SAME stale opId burns its retry budget
    //      (MATERIALIZE_MAX_ATTEMPTS=5) and parks it `dead` — visible, not lost;
    //   3. the admin reaps terminal claims (the /sync/claims/reap workflow);
    //   4. the current-base delete now claims, applies and tombstones.
    const blocked = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(DEV_ADMIN, "fabric", fabricId, "delete", {
        entityId: fabricId,
        baseVersion: fabricVersion,
        actorUserId: U_ADMIN,
        actorRole: "admin",
      }),
    });
    observe("current-base delete while the stale unit still holds the claim", blocked.status, blocked.body);
    check(
      "G2a a new delete is FWW-refused while the stale unit holds the claim",
      blocked.status === 409 && blocked.body?.code === "SYNC_CONFLICT",
    );

    let dead = null;
    for (let i = 0; i < MATERIALIZE_MAX_ATTEMPTS; i++) {
      const retry = await api("POST", "/sync/push", {
        token: TOKENS.admin,
        body: pushUnit(
          DEV_ADMIN,
          "fabric",
          fabricId,
          "delete",
          { entityId: fabricId, baseVersion: 1 },
          staleOpId, // SAME opId = the device retrying its own queued unit
        ),
      });
      dead = retry;
      if (retry.body?.hubStatus === "dead") break;
    }
    observe("stale unit re-pushed to its retry budget", dead.status, {
      hubStatus: dead.body?.hubStatus,
      terminal: dead.body?.terminal,
    });
    check(
      "G2b stale unit parks as dead (visible for the operator, still not applied)",
      dead.body?.hubStatus === "dead" && dead.body?.terminal === true,
    );

    const reap = await api("POST", "/sync/claims/reap", { token: TOKENS.admin });
    observe("admin reaps terminal claims", reap.status, reap.body);
    check("G2c reap releases the dead holder's claim", reap.status === 200);

    const r = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(DEV_ADMIN, "fabric", fabricId, "delete", {
        entityId: fabricId,
        baseVersion: fabricVersion,
        actorUserId: U_ADMIN,
        actorRole: "admin",
      }),
    });
    observe("delete with the current base", r.status, r.body);
    const c = await hubClient();
    const row = await c.query(`SELECT 1 FROM fabrics WHERE id = $1`, [fabricId]);
    const tomb = await c.query(
      `SELECT 1 FROM sync_tombstones WHERE tenant_id = $1 AND entity_id = $2`,
      [T1, fabricId],
    );
    await c.end();
    check(
      "G2d a current-base delete applies (and tombstones the row)",
      r.status === 201 && r.body?.materialized === true && row.rows.length === 0 && tomb.rows.length === 1,
      `push=${r.status} materialized=${r.body?.materialized}`,
    );
  }
  {
    // Requirement 10: a replayed create of the DELETED id must not resurrect it.
    const r = await api("POST", "/sync/push", {
      token: TOKENS.admin,
      body: pushUnit(DEV_ADMIN, "fabric", fabricId, "create", {
        snapshot: { id: fabricId, name: "Resurrected Fabric" },
      }),
    });
    observe("create replay of the deleted id", r.status, r.body);
    const c = await hubClient();
    const row = await c.query(`SELECT 1 FROM fabrics WHERE id = $1`, [fabricId]);
    await c.end();
    check(
      "G3 tombstone blocks resurrection of the deleted row",
      row.rows.length === 0,
      `push status=${r.status}`,
    );
  }
  {
    // Legitimate intentional recreation = a NEW row with a NEW id.
    const r = await api("POST", "/inventory/fabrics", {
      token: TOKENS.admin,
      deviceId: DEV_ADMIN,
      body: { name: "Batch4 Fabric (re-created)" },
    });
    observe("legitimate re-creation with a new id", r.status, r.body);
    check("G4 a new row with a new id is allowed", r.status < 300);
  }

  /* ---------------- summary ---------------- */
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n=== ${results.length - failed.length}/${results.length} checks passed ===`,
  );
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
}

main()
  .catch((err) => {
    console.error(err);
    results.push({ name: "drill crashed", pass: false, detail: String(err) });
  })
  .finally(async () => {
    await stopHub();
    if (!KEEP) {
      try {
        const c = await adminClient();
        await c.query(`DROP DATABASE IF EXISTS "${HUB.db}" WITH (FORCE)`);
        await c.end();
      } catch {
        /* ignore */
      }
    }
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  });
