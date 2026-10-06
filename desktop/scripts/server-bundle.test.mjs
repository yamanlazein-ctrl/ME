/**
 * The desktop runtime is ONE Node process (API + embedded SQLite engine), and the API is reached
 * over a Windows NAMED PIPE, not TCP (specs/001-desktop-sqlite-engine T048, US2).
 *
 * This boots the real staged bundle (resources/server) with the bundled node.exe exactly as the
 * Tauri runtime spawns it (stack.rs spawn_server): DB_ENGINE=sqlite, a FRESH data root, the bundled
 * SQLite migrations and the desktop seed. It proves:
 *   - it becomes ready only when the pipe answers /api/health/live (the probe stack.rs uses),
 *   - FRESH created <root>\data\motard.db with the runtime's data_id and install instance, wrote
 *     the db-meta.json sidecar, and seeded exactly the default tenant + signed licence, no users,
 *   - a restart (REUSE) reopens the same database; a NEW installation instance is refused and the
 *     file is left byte-identical,
 *   - the SPA shell and client-side routes are served with a document CSP, the API works on the
 *     same origin, and the bundle binds NO TCP port (8080 / 4173 decoys stay untouched).
 * Requires: bundle-server.mjs, the staged web/ dir, and build-desktop-seed.mjs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test, before, after } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";

const RESOURCES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources");
const SERVER_DIR = join(RESOURCES, "server");
const NODE_EXE = join(RESOURCES, "node.exe");
const SEED = join(SERVER_DIR, "desktop-seed.json");
const ready = [join(SERVER_DIR, "server.mjs"), join(SERVER_DIR, "web"), NODE_EXE, SEED].every(existsSync);
const Database = ready ? createRequire(join(SERVER_DIR, "server.mjs"))(join(SERVER_DIR, "node_modules", "better-sqlite3")) : null;

let work, child, pipePath, decoys = [];
const DATA_ID = randomUUID();
const INSTANCE = randomUUID();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP/1.1 exchange over the named pipe — the transport the desktop UI actually uses. */
function pipeFetch(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: pipePath, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: () => Buffer.concat(chunks).toString("utf8"),
          json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The pipe answers the liveness probe while the child is alive; fail at once when it exits. */
async function waitForPipe(proc, limitMs = 120_000) {
  const t0 = Date.now();
  let exited = null;
  let lastErr = "pipe never answered";
  proc.once("exit", (c) => (exited = c));
  while (Date.now() - t0 < limitMs) {
    try {
      const r = await pipeFetch("/api/health/live");
      if (r.status === 200) return r;
      lastErr = `health/live answered ${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    if (exited !== null) throw new Error(`server exited with code ${exited} before it was ready`);
    await sleep(150);
  }
  throw new Error(`server did not become ready within ${limitMs} ms (last: ${lastErr})`);
}

/** The environment stack.rs spawn_server gives the server. */
function serverEnv(state, instance) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !["DATABASE_URL", "TEST_DB_URL", "PGPASSWORD"].includes(k))),
    NODE_ENV: "production",
    DESKTOP_DEPLOY: "true",
    DESKTOP_PIPE: pipePath,
    HOST: "127.0.0.1",
    SERVE_STATIC_DIR: join(SERVER_DIR, "web"),
    CORS_ORIGIN: "http://127.0.0.1",
    LOG_DIR: join(work, "logs"),
    DB_ENGINE: "sqlite",
    SQLITE_PATH: join(work, "data", "motard.db"),
    MOTARD_STARTUP_STATE: state,
    MOTARD_DATA_ID: DATA_ID,
    MOTARD_INSTALLATION_ID: "server-bundle-test",
    MOTARD_INSTALL_INSTANCE_ID: instance,
    MOTARD_INSTALL_INSTANCE_CHECK: "1",
    DESKTOP_SEED_PATH: SEED,
    DESKTOP_SQLITE_MIGRATIONS_FOLDER: join(SERVER_DIR, "sqlite-migrations"),
    DESKTOP_DB_META_PATH: join(work, "db-meta.json"),
    DATA_INTEGRITY_PATH: join(work, "data-integrity.json"),
    JWT_SECRET: "j".repeat(48),
    APP_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    // Build-time smoke test: never write backups into the developer's Documents.
    BACKUP_MIRROR_DIR: "off",
    LICENSE_SIGNING_PUBLIC_KEY: readFileSync(join(RESOURCES, "license-public.pem"), "utf8"),
    LOG_LEVEL: "info",
  };
}

function startServer(state, instance = INSTANCE) {
  const proc = spawn(NODE_EXE, [join(SERVER_DIR, "server.mjs"), `--data-root=${work}`], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: serverEnv(state, instance),
  });
  proc.output = "";
  proc.stdout.on("data", (d) => (proc.output += d));
  proc.stderr.on("data", (d) => (proc.output += d));
  return proc;
}

async function stopServer(proc) {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await Promise.race([exited, sleep(10_000)]);
  }
}

before(async () => {
  if (!ready) return;
  for (const p of [8080, 4173]) {
    await new Promise((res, rej) => {
      const s = createHttpServer((_req, res) => res.end(`decoy:${p}`));
      s.once("error", (err) => rej(new Error(`cannot bind decoy on 127.0.0.1:${p} (${err.code ?? err.message}). Stop leftover node from a prior packaging run and retry.`)));
      s.listen(p, "127.0.0.1", () => {
        decoys.push(s);
        res();
      });
    });
  }
  work = mkdtempSync(join(tmpdir(), "motard-server-e2e-"));
  // A unique pipe per run: the well-known \\.\pipe\motard-erp belongs to the real app.
  pipePath = `\\\\.\\pipe\\motard-server-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
  child = startServer("FRESH");
  try {
    await waitForPipe(child);
  } catch (e) {
    throw new Error(`${e.message}\n--- server output ---\n${child.output}`);
  }
});

after(async () => {
  await stopServer(child);
  for (const s of decoys) s.close();
  if (work) {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(work, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
});

const t = (name, fn) => test(name, { skip: !ready && "run bundle-server.mjs, stage web/ and build-desktop-seed.mjs first" }, fn);

t("serves the API on the named pipe and takes no TCP port, even with 8080 and 4173 busy", async () => {
  for (const p of [8080, 4173]) {
    const r = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: p, path: "/", method: "GET", timeout: 5_000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`decoy check on :${p} timed out — another process may own the port`));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r, `decoy:${p}`, `port ${p} must still belong to the decoy, not the ERP`);
  }
  assert.equal((await pipeFetch("/api/health/live")).status, 200);
});

t("FRESH created the SQLite database with the runtime's identity, the sidecar, and only the seed", async () => {
  const db = new Database(join(work, "data", "motard.db"), { readonly: true });
  try {
    const meta = db.prepare("SELECT data_id, install_instance_id, created_by_installation_id FROM motard_meta WHERE id = 1").get();
    assert.deepEqual(meta, { data_id: DATA_ID, install_instance_id: INSTANCE, created_by_installation_id: "server-bundle-test" });
    const seed = JSON.parse(readFileSync(SEED, "utf8"));
    assert.deepEqual(db.prepare("SELECT id FROM tenants").all(), [{ id: seed.tenant.id }]);
    assert.equal(db.prepare("SELECT count(*) n FROM licenses WHERE tenant_id = ? AND offline_token IS NOT NULL").get(seed.tenant.id).n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM users").get().n, 0, "no users: the owner is created by onboarding");
  } finally {
    db.close();
  }
  const sidecar = JSON.parse(readFileSync(join(work, "db-meta.json"), "utf8"));
  assert.equal(sidecar.engine, "sqlite");
  assert.equal(sidecar.data_id, DATA_ID);
  assert.equal(sidecar.install_instance_id, INSTANCE);
});

t("API is live on the same origin and onboarding has not run", async () => {
  const r = await pipeFetch("/api/health/live");
  assert.equal(r.status, 200);
  const s = await (await pipeFetch("/api/setup/status")).json();
  assert.equal(s.isCompleted, false);
});

t("serves the SPA shell with a document CSP, and SPA routes fall back to it", async () => {
  for (const path of ["/", "/customers", "/invoices/sale/new"]) {
    const r = await pipeFetch(path, { headers: { accept: "text/html" } });
    assert.equal(r.status, 200, path);
    assert.match(r.headers["content-type"] ?? "", /text\/html/);
    const csp = r.headers["content-security-policy"] ?? "";
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /connect-src[^;]*http:\/\/ipc\.localhost/);
    assert.match(await r.text(), /<div id="root"|<script/i);
  }
});

t("unknown API paths answer with JSON errors (never the HTML shell)", async () => {
  const r = await pipeFetch("/api/does-not-exist", { headers: { accept: "text/html" } });
  assert.ok([404, 503].includes(r.status), `status ${r.status}`);
  assert.match(r.headers["content-type"] ?? "", /json/);
});

t("hashed assets are cached immutably", async () => {
  const html = await (await pipeFetch("/", { headers: { accept: "text/html" } })).text();
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  assert.ok(asset, "shell references a hashed asset");
  const r = await pipeFetch(asset);
  assert.equal(r.status, 200);
  assert.match(r.headers["cache-control"] ?? "", /immutable/);
});

t("a restart reopens the same database (REUSE); a new installation instance is refused, file untouched", async () => {
  await stopServer(child);
  child = startServer("REUSE");
  await waitForPipe(child);
  assert.equal((await (await pipeFetch("/api/setup/status")).json()).isCompleted, false);
  await stopServer(child);

  const file = join(work, "data", "motard.db");
  const db = new Database(file);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const before = createHash("sha256").update(readFileSync(file)).digest("hex");
  const refused = startServer("REUSE", randomUUID());
  const code = await new Promise((r) => refused.once("exit", r));
  assert.notEqual(code, 0, "a new installation must not serve the existing company");
  assert.match(refused.output, /INSTALL_INSTANCE_MISMATCH/);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), before, "the refused boot changed nothing");

  child = startServer("REUSE");
  await waitForPipe(child);
});
