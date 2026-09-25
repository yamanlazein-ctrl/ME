/**
 * The desktop runtime is ONE Node process (API + built SPA on the same origin) + PostgreSQL.
 * This boots the real staged bundle (resources/server) against a copy of the real database template and proves:
 *   - it takes a free port by itself (PORT=0) and announces it through the port file only when really ready,
 *   - the SPA shell and client-side routes are served with a document CSP,
 *   - the API works on the same origin,
 *   - a busy 8080 / 4173 does not matter (there are no fixed ports any more).
 * Requires: node desktop/scripts/bundle-server.mjs, the staged web/ dir and a built pgdata-template.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { RESOURCES, TEMPLATE_DIR, databaseUrl, freePort, startPostgres, stopPostgresClean } from "./pgdata-template-lib.mjs";

const SERVER_DIR = join(RESOURCES, "server");
const NODE_EXE = join(RESOURCES, "node.exe");
const ready = existsSync(join(SERVER_DIR, "server.mjs")) && existsSync(join(SERVER_DIR, "web")) && existsSync(NODE_EXE);

let work, pgdata, pgPort, child, base, decoys = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the port file while the child is alive; fail immediately when it exits (no blind timeout). */
async function waitForPortFile(file, proc, limitMs = 120_000) {
  const t0 = Date.now();
  let exited = null;
  proc.once("exit", (c) => (exited = c));
  while (Date.now() - t0 < limitMs) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (exited !== null) throw new Error(`server exited with code ${exited} before it was ready`);
    await sleep(100);
  }
  throw new Error(`server did not become ready within ${limitMs} ms`);
}

before(async () => {
  if (!ready) return;
  // Occupy the ports the OLD design hard-coded: the new one must not care.
  for (const p of [8080, 4173]) {
    await new Promise((res) => {
      const s = createServer();
      s.once("error", () => res());
      s.listen(p, "127.0.0.1", () => {
        decoys.push(s);
        res();
      });
    });
  }
  work = mkdtempSync(join(tmpdir(), "motard-server-e2e-"));
  pgdata = join(work, "pgdata");
  cpSync(TEMPLATE_DIR, pgdata, { recursive: true });
  pgPort = await freePort();
  startPostgres(pgdata, pgPort, join(work, "pg.log"));

  const portFile = join(work, "server-port.json");
  child = spawn(NODE_EXE, [join(SERVER_DIR, "server.mjs")], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      DESKTOP_DEPLOY: "true",
      PORT: "0",
      HOST: "127.0.0.1",
      DESKTOP_PORT_FILE: portFile,
      SERVE_STATIC_DIR: join(SERVER_DIR, "web"),
      DESKTOP_MIGRATIONS_FOLDER: join(SERVER_DIR, "migrations"),
      DATABASE_URL: databaseUrl(pgPort),
      JWT_SECRET: "j".repeat(48),
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      CORS_ORIGIN: "http://127.0.0.1",
      LOG_DIR: join(work, "logs"),
      // Build-time smoke test: never write backups into the developer's
      // Documents (it left a truncated auto-*.zip there when the test server
      // was stopped mid-copy).
      BACKUP_MIRROR_DIR: "off",
      LICENSE_SIGNING_PUBLIC_KEY: readFileSync(join(RESOURCES, "license-public.pem"), "utf8"),
      LOG_LEVEL: "info",
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    const { port } = await waitForPortFile(portFile, child);
    base = `http://127.0.0.1:${port}`;
  } catch (e) {
    throw new Error(`${e.message}\n--- server output ---\n${out}`);
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await sleep(300);
  }
  if (pgdata) {
    try {
      stopPostgresClean(pgdata);
    } catch {
      /* ignore */
    }
  }
  for (const s of decoys) s.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: !ready && "run bundle-server.mjs and stage web/ first" }, fn);

t("starts on a free port even though 8080 and 4173 are taken", () => {
  const port = Number(new URL(base).port);
  assert.ok(port > 0 && port !== 8080 && port !== 4173, `port ${port}`);
});

t("API is live on the same origin", async () => {
  const r = await fetch(`${base}/api/health/live`);
  assert.equal(r.status, 200);
  const s = await (await fetch(`${base}/api/setup/status`)).json();
  assert.equal(s.isCompleted, false);
});

t("serves the SPA shell with a document CSP, and SPA routes fall back to it", async () => {
  for (const path of ["/", "/customers", "/invoices/sale/new"]) {
    const r = await fetch(`${base}${path}`, { headers: { accept: "text/html" } });
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /connect-src 'self'/);
    // Tauri's IPC channel must be allowed or every desktop command is blocked by the CSP.
    assert.match(csp, /connect-src[^;]*http:\/\/ipc\.localhost/);
    assert.match(await r.text(), /<div id="root"|<script/i);
  }
});

t("unknown API paths answer with JSON errors (never the HTML shell)", async () => {
  const r = await fetch(`${base}/api/does-not-exist`, { headers: { accept: "text/html" } });
  // Before activation the install gate answers 503; afterwards 404 — either way it is a JSON API error.
  assert.ok([404, 503].includes(r.status), `status ${r.status}`);
  assert.match(r.headers.get("content-type") ?? "", /json/);
});

t("hashed assets are cached immutably", async () => {
  const html = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  assert.ok(asset, "shell references a hashed asset");
  const r = await fetch(`${base}${asset}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") ?? "", /immutable/);
});
