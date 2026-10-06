/**
 * Parity harness: start one backend (PostgreSQL reference or SQLite) from a CLEAN state, provision
 * the same company on it through the API, and read its database afterwards
 * (specs/001-desktop-sqlite-engine T050/T051, quickstart §2).
 *
 * Both engines run the real desktop mode (DESKTOP_DEPLOY=true) and start from identical content:
 * the build-time desktop seed (default tenant + pre-signed licence; backend/src/scripts/
 * build-desktop-seed.ts). SQLite inserts it on FRESH; the PostgreSQL run inserts the very same row
 * values after its migrations — exactly what the PG template shipped.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../..");
export const BACKEND = join(REPO, "backend");
const requireBackend = createRequire(join(BACKEND, "package.json"));

export const TENANT_ID = "00000000-0000-4000-8000-0000000000aa";
const FP = JSON.parse(readFileSync(join(BACKEND, "src/infrastructure/orm/migrations/meta/schema-fingerprint.json"), "utf8"));

/** Build (once) the desktop seed used by both engines. */
export function ensureSeed(seedPath) {
  if (existsSync(seedPath)) return seedPath;
  execFileSync(process.execPath, ["--env-file=.env", join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/scripts/build-desktop-seed.ts", "--out", seedPath], {
    cwd: BACKEND,
    env: { ...process.env, SEED_TENANT_ID: TENANT_ID, BAKED_LICENSE_KEY: "LIC-DESKTOP-PARITY0000000001" },
    stdio: "inherit",
  });
  return seedPath;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(base, proc, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`backend exited with ${proc.exitCode}`);
    try {
      const r = await fetch(`${base}/api/health/ready`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("backend did not become ready");
}

/** Insert the seed rows into a migrated PostgreSQL database (column types from the fingerprint). */
async function seedPostgres(url, seed) {
  const pg = requireBackend("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const [table, row] of [["tenants", seed.tenant], ["licenses", seed.license]]) {
      const cols = Object.keys(row);
      const types = FP.tables[table].columns;
      const vals = cols.map((k) => {
        const v = row[k];
        const t = types[k].type;
        if (v === null) return null;
        if (t.endsWith("[]")) return JSON.parse(v);
        return v;
      });
      const ph = cols.map((k, i) => `$${i + 1}::${types[k].type.replace(/^character varying\(\d+\)$/, "varchar")}`);
      await c.query(`INSERT INTO "${table}" (${cols.map((k) => `"${k}"`).join(", ")}) VALUES (${ph.join(", ")})`, vals);
    }
  } finally {
    await c.end();
  }
}

/**
 * Start a clean backend.
 * @param {"postgres"|"sqlite"} engine
 * @param {{ port: number, seedPath: string, pgAdminUrl?: string }} opts
 */
export async function startEngine(engine, opts) {
  const work = mkdtempSync(join(tmpdir(), `motard-parity-${engine}-`));
  const seed = JSON.parse(readFileSync(opts.seedPath, "utf8"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(opts.port),
    DESKTOP_DEPLOY: "true",
    CORS_ORIGIN: "http://localhost:5173",
    RATE_LIMIT_RPS: "100000",
    RATE_LIMIT_WINDOW_MS: "60000",
    LOG_LEVEL: "warn",
    LOG_DIR: join(work, "logs"),
    LICENSE_SERVER_MODE: "embedded",
    APP_MASTER_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
    JWT_SECRET: "parity-secret-32-chars-minimum-padding-xx",
    MOTARD_INSTALLATION_ID: "00000000-0000-4000-8000-0000000000bb", // a UUID, as the runtime mints (device_binding.rs)
    DEFAULT_TENANT_ID: TENANT_ID,
    BACKUP_MIRROR_DIR: "off",
  };
  let dbName = null;
  if (engine === "sqlite") {
    delete env.DATABASE_URL;
    delete env.TEST_DB_URL;
    Object.assign(env, {
      DB_ENGINE: "sqlite",
      SQLITE_PATH: join(work, "data", "motard.db"),
      MOTARD_STARTUP_STATE: "FRESH",
      DESKTOP_SEED_PATH: opts.seedPath,
    });
  } else {
    const pg = requireBackend("pg");
    dbName = `parity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new pg.Client({ connectionString: opts.pgAdminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    await admin.end();
    const url = new URL(opts.pgAdminUrl);
    url.pathname = `/${dbName}`;
    Object.assign(env, { DB_ENGINE: "postgres", DATABASE_URL: url.toString(), TEST_DB_URL: url.toString() });
  }
  // opts.serverEntry: a frozen server bundle (the T026 reference build) instead of the source tree.
  const entry = opts.serverEntry ? [opts.serverEntry] : [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/presentation/server.ts"];
  // A packaged SQLite build migrates with ITS OWN bundled migrations, not the source tree's (T119).
  if (opts.serverEntry && engine === "sqlite") env.DESKTOP_SQLITE_MIGRATIONS_FOLDER = join(dirname(opts.serverEntry), "sqlite-migrations");
  const proc = spawn(process.execPath, entry, {
    cwd: BACKEND,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${opts.port}`;
  try {
    await waitHealthy(base, proc);
  } catch (e) {
    proc.kill();
    throw new Error(`${engine} backend failed to start: ${e.message}\n${log.slice(-3000)}`);
  }
  if (engine === "postgres") await seedPostgres(env.DATABASE_URL, seed);
  return {
    engine,
    base,
    work,
    env,
    dbName,
    log: () => log,
    async stop() {
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        else proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await sleep(500);
      if (dbName) {
        const pg = requireBackend("pg");
        const admin = new pg.Client({ connectionString: opts.pgAdminUrl });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
        await admin.end();
      }
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Minimal API client that keeps the session and an Idempotency-Key per mutation. */
export function apiClient(base) {
  let token = null;
  let seq = 0;
  const client = {
    /** opts.tag: an idempotency-key tag (e.g. "conc" for parallel requests; see canonical.mjs). */
    async call(method, path, body, opts = {}) {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (method !== "GET") headers["Idempotency-Key"] = `parity-${opts.tag ? `${opts.tag}-` : ""}${String(++seq).padStart(8, "0")}-${method}-${path.length}`;
      const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: res.status, body: json };
    },
    setToken(t) {
      token = t;
    },
  };
  return client;
}

/** Desktop onboarding: init → activate (baked licence) → company → admin → review → complete → login. */
export async function provisionCompany(api, tenantId = TENANT_ID) {
  const steps = [];
  const must = async (label, method, path, body) => {
    const r = await api.call(method, path, body);
    steps.push({ label, status: r.status });
    if (r.status >= 300) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  await must("init", "POST", "/api/setup/init", {});
  await must("activate", "POST", "/api/setup/wizard/activate", { key: "", tenantId, platform: "windows", hostname: "parity-host", fingerprint: "parity-fingerprint-0000000000000001" });
  await must("company", "POST", "/api/setup/wizard/company", { tenantId, name: "شركة التكافؤ", currency: "SYP", city: "دمشق", fiscalYearStart: "2026-01-01" });
  await must("admin", "POST", "/api/setup/wizard/admin", { tenantId, name: "المدير", email: "admin@erp.local", password: "Parity-Pass-2026!" });
  await must("review", "POST", "/api/setup/wizard/review", { tenantId, confirmed: true });
  await must("complete", "POST", "/api/setup/wizard/complete", { tenantId });
  const login = await must("login", "POST", "/api/auth/login", { email: "admin@erp.local", password: "Parity-Pass-2026!", tenantId });
  api.setToken(login.accessToken);
  return steps;
}

/**
 * Read every business table in a common representation: numeric as PG text at the column scale,
 * booleans as booleans, jsonb/arrays parsed, timestamps as instants (ISO), dates as text.
 */
export async function readTables(handle) {
  const out = {};
  const tables = Object.keys(FP.tables).sort();
  if (handle.engine === "sqlite") {
    const Database = requireBackend("better-sqlite3");
    const db = new Database(handle.env.SQLITE_PATH, { readonly: true });
    db.defaultSafeIntegers(true);
    try {
      for (const t of tables) {
        const cols = FP.tables[t].columns;
        out[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => {
          const o = {};
          for (const [k, v] of Object.entries(r)) o[k] = normalize(cols[k]?.type, v, "sqlite");
          return o;
        });
      }
    } finally {
      db.close();
    }
  } else {
    const pg = requireBackend("pg");
    const c = new pg.Client({ connectionString: handle.env.DATABASE_URL });
    c.setTypeParser?.(1700, (v) => v);
    await c.connect();
    try {
      for (const t of tables) {
        const cols = FP.tables[t].columns;
        const r = await c.query({ text: `SELECT * FROM "${t}"`, types: { getTypeParser: (oid) => (oid === 1700 || oid === 1184 || oid === 1082 || oid === 20) ? (v) => v : pg.types.getTypeParser(oid) } });
        out[t] = r.rows.map((row) => {
          const o = {};
          for (const [k, v] of Object.entries(row)) o[k] = normalize(cols[k]?.type, v, "pg");
          return o;
        });
      }
    } finally {
      await c.end();
    }
  }
  return out;
}

function scaleOf(type) {
  const m = /^numeric\((\d+),(\d+)\)$/.exec(type ?? "");
  return m ? Number(m[2]) : null;
}

function formatScaled(v, scale) {
  const neg = v < 0n;
  const d = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const body = scale ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d;
  return neg ? `-${body}` : body;
}

function normalize(type, v, from) {
  if (v === null || v === undefined) return null;
  const scale = scaleOf(type);
  if (scale !== null) return from === "sqlite" ? formatScaled(BigInt(v), scale) : String(v);
  if (type === "boolean") return from === "sqlite" ? v === 1n || v === 1 : Boolean(v);
  if (type === "jsonb") return from === "sqlite" ? JSON.parse(String(v)) : v;
  if (type?.endsWith("[]")) return from === "sqlite" ? JSON.parse(String(v)) : v;
  if (type === "timestamp with time zone") {
    const s = String(v);
    // instant with µs, engine-independent: PG "2026-10-04 09:35:01.1234+00" / SQLite "…T…·123400Z"
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00(?::00)?)$/.exec(s);
    return m ? `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(6, "0")}Z` : s;
  }
  if (type === "integer" || type === "bigint") return Number(v);
  return typeof v === "bigint" ? Number(v) : v;
}
