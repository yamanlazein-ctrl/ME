#!/usr/bin/env node
/**
 * Disposable stack for the certification e2e suites (tests/e2e/playwright.cert.config.ts).
 *
 *   E2E_ADMIN_PASSWORD=… node tests/e2e/cert-stack.mjs [--db erp_cert] [--pg <admin url>] [--root <repo checkout>]
 *
 * --root serves the backend and UI from another checkout (e.g. a worktree of an earlier commit, to
 * compare suite results across commits); migrations, seeding and this script stay the current ones.
 *
 * 1. (Re)creates a disposable PostgreSQL database (name must start with `erp_cert`), migrated: cloned
 *    from the migrated `ac8_tpl` template when it exists, otherwise `drizzle-kit migrate`.
 * 2. Seeds one licensed tenant with a completed setup and an admin user whose password is
 *    E2E_ADMIN_PASSWORD (Argon2id, same parameters as Argon2PasswordHasher).
 * 3. Starts the backend on :8080 (web/cloud mode, not desktop) and the UI (Vite) on :8081 with
 *    VITE_API_BASE_URL=http://localhost:8080 — the cert config's defaults — and the UI's existing
 *    VITE_ACTIVATION_BYPASS=1 (licence activation is outside these suites).
 * 4. Writes the tenant id to tests/e2e/.cert-stack.json (git-ignored) for the login helper, then
 *    keeps both servers running until the process is stopped.
 *
 * The admin URL defaults to backend/.env.test's DATABASE_URL re-pointed at the 55432 throwaway
 * cluster's `postgres` database; it is never printed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const BACKEND = join(REPO, "backend");
const rootArg = process.argv.indexOf("--root");
/** Checkout whose backend and UI are served (default: this one). */
const SERVE = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : REPO;
const requireBackend = createRequire(join(BACKEND, "package.json"));
const pg = requireBackend("pg");
const { hash } = requireBackend("@node-rs/argon2");

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DB = arg("db", "erp_cert");
if (!/^erp_cert[a-z0-9_]*$/.test(DB)) throw new Error(`refusing database "${DB}": disposable erp_cert* databases only`);
const email = process.env.E2E_ADMIN_EMAIL ?? "admin@erp.local";
const password = process.env.E2E_ADMIN_PASSWORD;
if (!password) throw new Error("E2E_ADMIN_PASSWORD is required (DFP-029: no embedded passwords)");

function adminUrl() {
  const explicit = arg("pg", process.env.CERT_PG_URL);
  if (explicit) return explicit;
  const line = readFileSync(join(BACKEND, ".env.test"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("no --pg/CERT_PG_URL and backend/.env.test has no DATABASE_URL");
  const u = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, ""));
  u.port = process.env.CERT_PG_PORT ?? "55432";
  u.pathname = "/postgres";
  return u.toString();
}
const admin = adminUrl();
const dbUrl = (() => {
  const u = new URL(admin);
  u.pathname = `/${DB}`;
  return u.toString();
})();

async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ── 1. database ──
const hasTemplate = await withClient(admin, async (c) => {
  await c.query(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  const t = (await c.query("SELECT 1 FROM pg_database WHERE datname = 'ac8_tpl'")).rowCount > 0;
  await c.query(t ? `CREATE DATABASE "${DB}" TEMPLATE "ac8_tpl"` : `CREATE DATABASE "${DB}" TEMPLATE template0 ENCODING 'UTF8'`);
  return t;
});
if (!hasTemplate) {
  console.log("[cert-stack] migrating (no ac8_tpl template yet, ~2 min)…");
  const r = spawnSync(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "migrate"], { cwd: BACKEND, env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "test" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`migrate failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-3000));
}

// ── 2. seed ──
const tenantId = randomUUID();
const userId = randomUUID();
const passwordHash = await hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 4, algorithm: 2 });
await withClient(dbUrl, async (c) => {
  await c.query(
    `INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES ($1, 'Cert Co', 'default', 'active', 'active', 'perpetual')`,
    [tenantId],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES ($1, $2, 'Admin', $3, $4, 'admin', true)`,
    [userId, tenantId, email, passwordHash],
  );
  await c.query(
    `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES ($1, 'done', ARRAY['welcome'], true, now())`,
    [tenantId],
  );
});
writeFileSync(join(here, ".cert-stack.json"), JSON.stringify({ tenantId, email, backend: "http://localhost:8080", ui: "http://localhost:8081" }, null, 2));
console.log(`[cert-stack] ${DB} ready (tenant ${tenantId})`);

// ── 3. servers ──
const children = [];
const start = (name, cmd, args, cwd, env, log) => {
  const out = openSync(join(here, log), "w");
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", out, out] });
  child.__name = name;
  children.push(child);
  return child;
};
const backendEnv = { ...process.env, NODE_ENV: "test", DB_ENGINE: "postgres", DATABASE_URL: dbUrl, TEST_DB_URL: dbUrl, PORT: "8080", HOST: "127.0.0.1",
  JWT_SECRET: process.env.JWT_SECRET ?? "cert-stack-jwt-secret-32-chars-minimum!!", APP_MASTER_KEY: process.env.APP_MASTER_KEY ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
  CORS_ORIGIN: "http://localhost:8081", RATE_LIMIT_RPS: "100000", RATE_LIMIT_WINDOW_MS: "60000", LOG_LEVEL: "warn", DEFAULT_TENANT_ID: tenantId };
for (const k of ["DESKTOP_DEPLOY", "DESKTOP_PIPE", "CENTRAL_SYNC_URL", "SQLITE_PATH", "MOTARD_STARTUP_STATE"]) delete backendEnv[k];
start("backend", process.execPath, [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/presentation/server.ts"], join(SERVE, "backend"), backendEnv, ".cert-backend.log");
// VITE_ACTIVATION_BYPASS: the UI's existing dev/test switch for the local device-activation marker
// (ActivationGate). The suites test the ERP screens, not licence activation.
const uiEnv = { ...process.env, VITE_API_BASE_URL: "http://localhost:8080", VITE_ACTIVATION_BYPASS: "1" };
delete uiEnv.VITE_DESKTOP_DEPLOY;
start("ui", process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--port", "8081", "--strictPort", "--host", "localhost"], SERVE, uiEnv, ".cert-ui.log");

const wait = async (url, label) => {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not start (see tests/e2e/.cert-${label}.log)`);
};
await wait("http://127.0.0.1:8080/api/health/live", "backend");
await wait("http://localhost:8081/", "ui");
console.log("[cert-stack] backend :8080 and ui :8081 up — Ctrl+C to stop");

const stop = () => {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGKILL");
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { if (!existsSync(join(here, ".cert-stack.json"))) return; console.error(`[cert-stack] ${c.__name} exited (${code})`); stop(); });
setInterval(() => {}, 60_000);
