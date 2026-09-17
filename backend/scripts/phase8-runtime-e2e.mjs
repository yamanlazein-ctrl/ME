/**
 * Phase 8 runtime E2E — isolated erp_test only (never touches `erp`).
 * Run from backend/:  node scripts/phase8-runtime-e2e.mjs
 */
import { spawn } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, SignJWT, importJWK } from "jose";
import pg from "pg";
import { hash } from "@node-rs/argon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(__dirname, "..");
const TEST_DB = "postgresql://postgres:postgres@127.0.0.1:5432/erp_test";
const ERP = "http://127.0.0.1:18080";
const LIC = "http://127.0.0.1:18091";
const ADMIN_TOKEN = `p8-admin-${randomUUID()}`;
// Isolated erp_test uses the vitest master key — never the operational .env key.
// Signing keys still come from backend/.env so resign/verify share one keypair.
function loadEnvFile() {
  const envPath = join(BACKEND, ".env");
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v.replace(/\\n/g, "\n");
  }
  return out;
}
const fileEnv = loadEnvFile();
const APP_MASTER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
const JWT_SECRET = "test-secret-32-chars-minimum-padding-padding";
const MASTER = Buffer.from(APP_MASTER_KEY, "base64");

const results = [];
function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`       ${evidence}`);
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text), raw: text };
  } catch {
    return { status: res.status, body: null, raw: text };
  }
}

function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", MASTER, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    algorithm: "aes-256-gcm",
  };
}

function loadSigningPems() {
  let priv = process.env.LICENSE_SIGNING_KEY || fileEnv.LICENSE_SIGNING_KEY;
  let pub = process.env.LICENSE_SIGNING_PUBLIC_KEY || fileEnv.LICENSE_SIGNING_PUBLIC_KEY || "";
  if (priv?.includes("\\n")) priv = priv.replace(/\\n/g, "\n");
  if (pub?.includes("\\n")) pub = pub.replace(/\\n/g, "\n");
  if (!priv) throw new Error("LICENSE_SIGNING_KEY missing");
  return { priv, pub };
}

async function signOfflineToken({ licenseId, tenantId, fingerprint, jti, privPem, pubPem }) {
  const priv = createPrivateKey(privPem);
  const pub = pubPem ? createPublicKey(pubPem) : createPublicKey(priv);
  const privateJwk = priv.export({ format: "jwk" });
  const publicJwk = pub.export({ format: "jwk" });
  const key = await importJWK(privateJwk, "EdDSA");
  const kid = publicJwk.kid ?? "p8";
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
  return new SignJWT({
    license_id: licenseId,
    tenant_id: tenantId,
    features: ["feature.inventory", "feature.sales", "feature.accounting"],
    expires_at: expiresAt,
    server_fingerprint: fingerprint,
    edition: "standard",
    plan: "pro",
    license_version: "v1",
    product_version: "1.0.0",
    license_model: "perpetual",
    binding_type: "machine",
    binding_value: fingerprint,
    limits: { users: 10, devices: 5, branches: 1, warehouses: 1, storage_gb: 10, api_calls: 0 },
    transfer_policy: { allowed: true, max_transfers: 3, requires_super_admin: true },
    update_policy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
    backup_policy: { enabled: true, cloud_backup: false, max_backups: 30 },
  })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "LIC" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(key);
}

async function putSecret(c, tenantId, key, plaintext) {
  const enc = encryptSecret(plaintext);
  await c.query(
    `INSERT INTO secrets (tenant_id, key, ciphertext, iv, auth_tag, algorithm, version)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 1)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       algorithm = EXCLUDED.algorithm,
       version = secrets.version + 1,
       rotated_at = now()`,
    [tenantId, key, enc.ciphertext, enc.iv, enc.authTag, enc.algorithm],
  );
}

async function seedOffline(c, { tenantId, licenseId, fingerprint, pems }) {
  const jti = randomUUID();
  const token = await signOfflineToken({
    licenseId,
    tenantId,
    fingerprint,
    jti,
    privPem: pems.priv,
    pubPem: pems.pub,
  });
  await putSecret(c, tenantId, "license.token.current", token);
  await putSecret(c, tenantId, "license.token.jti", jti);
  await c.query(
    `UPDATE licenses SET status='active', offline_token=$2, offline_token_jti=$3, updated_at=now()
     WHERE id=$1::uuid`,
    [licenseId, token, jti],
  );
  return { token, jti };
}

async function prepare(pems) {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();

  const wiz = await c.query(
    `select 1 from information_schema.tables where table_schema='public' and table_name='setup_wizard_state'`,
  );
  if (!wiz.rowCount) throw new Error("setup_wizard_state missing — migrate erp_test first");

  const tenantA = "b6ac55ec-84c7-4fe5-bf76-d459825d4b61";
  const tenantB = (
    await c.query(`select id::text as id from tenants where id <> $1::uuid limit 1`, [tenantA])
  ).rows[0]?.id;
  if (!tenantB) throw new Error("need second tenant");

  for (const tid of [tenantA, tenantB]) {
    await c.query(
      `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
       VALUES ($1::uuid, 'done', ARRAY['done'], true, now())
       ON CONFLICT (tenant_id) DO UPDATE SET is_completed=true, current_step='done', completed_at=now()`,
      [tid],
    );
  }

  const pwHash = await hash("admin123");
  await c.query(
    `UPDATE users SET password_hash=$2, active=true, role='admin'
     WHERE email='admin@erp.local' AND tenant_id=$1::uuid`,
    [tenantA, pwHash],
  );

  const bAdmin = await c.query(
    `SELECT id::text AS id, email FROM users WHERE tenant_id=$1::uuid AND role='admin' AND active LIMIT 1`,
    [tenantB],
  );
  let tenantBEmail = bAdmin.rows[0]?.email;
  if (!tenantBEmail) {
    tenantBEmail = `p8-b-${tenantB.slice(0, 8)}@test.local`;
    await c.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
       VALUES ($1::uuid,'P8 B',$2,$3,'admin',true)`,
      [tenantB, tenantBEmail, pwHash],
    );
  } else {
    await c.query(`UPDATE users SET password_hash=$2, active=true WHERE id=$1::uuid`, [
      bAdmin.rows[0].id,
      pwHash,
    ]);
  }

  const userA2Email = `p8-a2-${randomUUID().slice(0, 8)}@test.local`;
  await c.query(
    `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
     VALUES ($1::uuid,'P8 A2',$2,$3,'accountant',true)
     ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash=EXCLUDED.password_hash, active=true`,
    [tenantA, userA2Email, pwHash],
  );

  await c.query(`DELETE FROM license_activations WHERE notes='phase8-e2e'`);
  await c.query(`DELETE FROM licenses WHERE key LIKE 'P8-E2E-%'`);

  const features = [
    "feature.inventory",
    "feature.accounting",
    "feature.sales",
    "feature.purchasing",
    "feature.reports",
  ];

  async function insertLicense(tenantId, suffix) {
    const key = `P8-E2E-${suffix}-${randomUUID().slice(0, 8)}`;
    const lic = await c.query(
      `INSERT INTO licenses (
         key, type, status, tenant_id, features, grace_days, max_devices,
         edition, plan, license_model, limits
       ) VALUES (
         $1,'full','active',$2::uuid,$3::text[],7,5,
         'standard','pro','perpetual',
         '{"users":10,"devices":5,"branches":1,"warehouses":1,"storage_gb":10,"api_calls":0}'::jsonb
       ) RETURNING id::text AS id`,
      [key, tenantId, features],
    );
    const licenseId = lic.rows[0].id;
    await c.query(
      `INSERT INTO license_activations (license_id, tenant_id, server_fingerprint, hostname, notes)
       VALUES ($1::uuid,$2::uuid,$3,'p8-e2e','phase8-e2e')`,
      [licenseId, tenantId, `p8-fp-${suffix}`],
    );
    return { licenseId, key, fingerprint: `p8-fp-${suffix}` };
  }

  const licA = await insertLicense(tenantA, "A");
  const licB = await insertLicense(tenantB, "B");
  const seededA = await seedOffline(c, {
    tenantId: tenantA,
    licenseId: licA.licenseId,
    fingerprint: licA.fingerprint,
    pems,
  });
  const seededB = await seedOffline(c, {
    tenantId: tenantB,
    licenseId: licB.licenseId,
    fingerprint: licB.fingerprint,
    pems,
  });

  await c.end();
  return { tenantA, tenantB, tenantBEmail, userA2Email, licA, licB, seededA, seededB };
}

function spawnServer(label, script, env) {
  const tsxCli = join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: BACKEND,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const lines = [];
  const onData = (d) => {
    const s = d.toString();
    lines.push(s);
    if (process.env.P8_VERBOSE) process.stdout.write(`[${label}] ${s}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return { child, lines, label };
}

function killTree(pid) {
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  } catch {}
}

async function waitErp(tries = 45) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${ERP}/api/health/live`);
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function waitLic(tries = 45) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${LIC}/license-admin/licenses`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (r.status === 200 || r.status === 401 || r.status === 403) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function login(email, password, tenantId) {
  return json(
    await fetch(`${ERP}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, tenantId }),
    }),
  );
}

async function getParties(token) {
  return json(
    await fetch(`${ERP}/api/parties?page=1&limit=5`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

async function main() {
  if (MASTER.length !== 32) throw new Error(`APP_MASTER_KEY must be 32 bytes, got ${MASTER.length}`);
  const pems = loadSigningPems();
  console.log("Preparing erp_test…");
  const fx = await prepare(pems);
  console.log("Fixtures ready", {
    tenantA: fx.tenantA,
    tenantB: fx.tenantB,
    licA: fx.licA.licenseId,
    licB: fx.licB.licenseId,
  });

  const envCommon = {
    NODE_ENV: "development",
    DATABASE_URL: TEST_DB,
    JWT_SECRET,
    APP_MASTER_KEY,
    JWT_EXPIRY_MS: "1800000",
    REFRESH_TOKEN_EXPIRY_MS: "2592000000",
    CORS_ORIGIN: "*",
    RATE_LIMIT_RPS: "1000",
    RATE_LIMIT_WINDOW_MS: "60000",
    LOG_LEVEL: "error",
    LICENSE_ADMIN_TOKEN: ADMIN_TOKEN,
    LICENSE_SIGNING_KEY: pems.priv.replace(/\n/g, "\\n"),
    LICENSE_SIGNING_PUBLIC_KEY: pems.pub.replace(/\n/g, "\\n"),
    SUPER_ADMIN_EMAIL: "super@p8.test",
    SUPER_ADMIN_PASSWORD: "SuperAdminP8!23456",
  };

  const erp = spawnServer("erp", "src/presentation/server.ts", {
    ...envCommon,
    PORT: "18080",
    LICENSE_SERVER_MODE: "embedded",
  });
  const licenseServer = spawnServer("lic", "src/scripts/license-server.ts", {
    ...envCommon,
    LICENSE_SERVER_MODE: "server",
    LICENSE_SERVER_PORT: "18091",
    PORT: "18091",
  });

  const killAll = () => {
    killTree(erp.child.pid);
    killTree(licenseServer.child.pid);
  };
  process.on("exit", killAll);
  process.on("SIGINT", () => {
    killAll();
    process.exit(1);
  });

  try {
    const erpUp = await waitErp();
    const licUp = await waitLic();
    record("env.erp_up", erpUp, erpUp ? "OK" : erp.lines.slice(-6).join("").slice(0, 400));
    record("env.license_server_up", licUp, licUp ? "OK" : licenseServer.lines.slice(-8).join("").slice(0, 400));
    if (!erpUp || !licUp) throw new Error("servers failed to start");

    const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

    // 1) active → business API
    const loginA = await login("admin@erp.local", "admin123", fx.tenantA);
    const tokenA = loginA.body?.accessToken;
    record("e2e.login_active_tenant", loginA.status === 200 && !!tokenA, `status=${loginA.status}`);
    const partiesActive = await getParties(tokenA);
    record(
      "e2e.active_business_api",
      partiesActive.status === 200,
      `status=${partiesActive.status} code=${partiesActive.body?.code ?? "ok"} raw=${(partiesActive.raw || "").slice(0, 160)}`,
    );

    const loginB = await login(fx.tenantBEmail, "admin123", fx.tenantB);
    const tokenB = loginB.body?.accessToken;
    record("e2e.tenant_b_baseline", (await getParties(tokenB)).status === 200, `login=${loginB.status}`);

    const loginA2 = await login(fx.userA2Email, "admin123", fx.tenantA);
    const tokenA2 = loginA2.body?.accessToken;
    record("e2e.same_tenant_user2_baseline", (await getParties(tokenA2)).status === 200, `login=${loginA2.status}`);

    // 2) suspend
    const sus = await json(
      await fetch(`${LIC}/license-admin/licenses/${fx.licA.licenseId}/suspend`, {
        method: "POST",
        headers: auth,
      }),
    );
    record(
      "e2e.suspend_vendor",
      sus.status === 200 && sus.body?.license?.status === "suspended",
      `status=${sus.status} refresh=${JSON.stringify(sus.body?.entitlementRefresh)}`,
    );

    const afterSus = await getParties(tokenA);
    record(
      "e2e.suspend_blocks_business",
      afterSus.status === 403 && afterSus.body?.code === "LICENSE_SUSPENDED",
      `status=${afterSus.status} code=${afterSus.body?.code}`,
    );
    const a2Sus = await getParties(tokenA2);
    record(
      "e2e.same_tenant_user2_blocked",
      a2Sus.status === 403 && a2Sus.body?.code === "LICENSE_SUSPENDED",
      `status=${a2Sus.status} code=${a2Sus.body?.code}`,
    );
    const bSus = await getParties(tokenB);
    record("e2e.other_tenant_unaffected_after_suspend", bSus.status === 200, `status=${bSus.status}`);

    // 3) stale valid token + SoT suspended
    const c = new pg.Client({ connectionString: TEST_DB });
    await c.connect();
    const stale = await seedOffline(c, {
      tenantId: fx.tenantA,
      licenseId: fx.licA.licenseId,
      fingerprint: fx.licA.fingerprint,
      pems,
    });
    await c.query(`UPDATE licenses SET status='suspended', updated_at=now() WHERE id=$1::uuid`, [
      fx.licA.licenseId,
    ]);
    // keep secrets (seed set them) — SoT suspended wins
    const staleBlocked = await getParties(tokenA);
    record(
      "e2e.stale_token_blocked_by_sot",
      staleBlocked.status === 403 && staleBlocked.body?.code === "LICENSE_SUSPENDED",
      `status=${staleBlocked.status} code=${staleBlocked.body?.code} jti=${stale.jti}`,
    );

    // 4) revoke
    const rev = await json(
      await fetch(`${LIC}/license-admin/licenses/${fx.licA.licenseId}`, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
    );
    record(
      "e2e.revoke_vendor",
      rev.status === 200 && rev.body?.license?.status === "revoked",
      `status=${rev.status} refresh=${JSON.stringify(rev.body?.entitlementRefresh)}`,
    );

    const sec = await c.query(
      `SELECT key FROM secrets WHERE tenant_id=$1::uuid AND key IN ('license.token.current','license.token.jti')`,
      [fx.tenantA],
    );
    record("e2e.revoke_clears_secrets", sec.rowCount === 0, `remaining=${sec.rowCount}`);

    const denied = await c.query(`SELECT 1 FROM revoked_tokens WHERE jti=$1::uuid`, [stale.jti]);
    record(
      "e2e.revoke_denylists_canonical_jti",
      denied.rowCount === 1,
      `stale.jti denylisted=${denied.rowCount === 1}`,
    );

    // Re-inject denylisted token while SoT is forced active (isolates R11 path).
    await putSecret(c, fx.tenantA, "license.token.current", stale.token);
    await putSecret(c, fx.tenantA, "license.token.jti", stale.jti);
    await c.query(
      `UPDATE licenses SET status='active', offline_token=$2, offline_token_jti=$3, updated_at=now()
       WHERE id=$1::uuid`,
      [fx.licA.licenseId, stale.token, stale.jti],
    );
    // Ensure this license is the latest for the tenant (findLatestForTenant).
    await c.query(
      `UPDATE licenses SET created_at = now(), updated_at = now() WHERE id=$1::uuid`,
      [fx.licA.licenseId],
    );
    const live = await c.query(
      `SELECT expires_at > now() AS live FROM revoked_tokens WHERE jti=$1::uuid`,
      [stale.jti],
    );
    const sec2 = await c.query(
      `SELECT 1 FROM secrets WHERE tenant_id=$1::uuid AND key='license.token.current'`,
      [fx.tenantA],
    );
    const tokRej = await getParties(tokenA);
    const licStatus = await json(
      await fetch(`${ERP}/api/license/status`, {
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    );
    record(
      "e2e.denylist_code_LICENSE_TOKEN_REVOKED",
      tokRej.status === 403 && tokRej.body?.code === "LICENSE_TOKEN_REVOKED",
      `status=${tokRej.status} code=${tokRej.body?.code} denylistLive=${live.rows[0]?.live} secretPresent=${sec2.rowCount} licStatus=${licStatus.status}:${JSON.stringify(licStatus.body)?.slice(0, 200)} body=${(tokRej.raw || "").slice(0, 180)}`,
    );

    // 5) reactivate / resign
    const uns = await json(
      await fetch(`${LIC}/license-admin/licenses/${fx.licA.licenseId}`, {
        method: "PATCH",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      }),
    );
    record(
      "e2e.unsuspend_resign",
      uns.status === 200 &&
        uns.body?.license?.status === "active" &&
        uns.body?.entitlementRefresh?.action === "resigned",
      `status=${uns.status} refresh=${JSON.stringify(uns.body?.entitlementRefresh)}`,
    );
    if (uns.body?.entitlementRefresh?.action !== "resigned") {
      await seedOffline(c, {
        tenantId: fx.tenantA,
        licenseId: fx.licA.licenseId,
        fingerprint: fx.licA.fingerprint,
        pems,
      });
    }
    const restored = await getParties(tokenA);
    record(
      "e2e.access_restored",
      restored.status === 200,
      `status=${restored.status} code=${restored.body?.code ?? "ok"}`,
    );

    // 6) ERP without License Server
    killTree(licenseServer.child.pid);
    await sleep(1500);
    let licDead = false;
    try {
      await fetch(`${LIC}/license-admin/licenses`, { headers: auth });
    } catch {
      licDead = true;
    }
    const aOff = await getParties(tokenA);
    const bOff = await getParties(tokenB);
    record(
      "e2e.erp_without_license_server",
      licDead && aOff.status === 200 && bOff.status === 200,
      `licDead=${licDead} A=${aOff.status} B=${bOff.status}`,
    );

    await c.end();
  } finally {
    killAll();
  }

  console.log("\n======== Phase 8 E2E SUMMARY ========");
  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} | ${r.name} | ${r.evidence}`);
  console.log(failed.length ? `\n${failed.length} FAILED` : "\nALL SCENARIOS PASSED");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
