#!/usr/bin/env node
/**
 * Parity runner (specs/001-desktop-sqlite-engine T050/T051): start ONE engine from a clean state,
 * provision the company through the desktop onboarding API, drive every scenario in ./scenarios
 * over HTTP, then write the canonical export (API transcript + every business table).
 *
 *   node scripts/parity/run.mjs --engine postgres|sqlite --out <dir> [--port 18080]
 *   node scripts/parity/diff.mjs <postgresOut> <sqliteOut>
 *
 * PostgreSQL needs an admin URL for a disposable database (PARITY_PG_URL, or the DATABASE_URL in
 * backend/.env.test re-pointed at the 55432 cluster's `postgres` database). It is never printed.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startEngine, apiClient, provisionCompany, readTables, ensureSeed, BACKEND } from "./lib/engine.mjs";
import { canonicalize } from "./lib/canonical.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const engine = arg("engine");
const out = arg("out");
const port = Number(arg("port") ?? 18080);
if (!["postgres", "sqlite"].includes(engine ?? "") || !out) {
  console.error("usage: node scripts/parity/run.mjs --engine postgres|sqlite --out <dir> [--port N]");
  process.exit(2);
}

function pgAdminUrl() {
  if (process.env.PARITY_PG_URL) return process.env.PARITY_PG_URL;
  const line = readFileSync(join(BACKEND, ".env.test"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("PARITY_PG_URL unset and backend/.env.test has no DATABASE_URL");
  const u = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, ""));
  u.port = process.env.PARITY_PG_PORT ?? "55432";
  u.pathname = "/postgres";
  return u.toString();
}

const scenarioDir = join(here, "scenarios");
const scenarios = existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((f) => f.endsWith(".mjs")).sort() : [];
if (scenarios.length === 0) {
  console.error("[parity:run] no scenarios — refusing to produce an empty export");
  process.exit(1);
}

const seedPath = ensureSeed(join(here, "out", "desktop-seed.json"));
// --reference <server.mjs>: run the frozen T026 reference bundle (PostgreSQL oracle, AC-3).
// --server <server.mjs>: run a packaged SQLite build (e.g. the T116 release candidate) instead of the source tree (T119).
const reference = arg("reference");
if (reference && engine !== "postgres") throw new Error("--reference is the PostgreSQL oracle");
const packaged = arg("server");
if (packaged && engine !== "sqlite") throw new Error("--server runs a packaged SQLite build");
const serverEntry = reference ?? packaged;
const handle = await startEngine(engine, { port, seedPath, serverEntry, pgAdminUrl: engine === "postgres" ? pgAdminUrl() : undefined });
const transcript = {};
let failed = null;
try {
  const api = apiClient(handle.base);
  transcript["00-onboarding"] = await provisionCompany(api);
  const state = {};
  for (const file of scenarios) {
    const name = file.replace(/\.mjs$/, "");
    const steps = [];
    transcript[name] = steps;
    const step = async (label, method, path, body) => {
      const r = await api.call(method, path, body);
      steps.push({ label, method, path: scrubPath(path), status: r.status, body: scrub(r.body) });
      return r.body;
    };
    const mod = await import(pathToFileURL(join(scenarioDir, file)).href);
    console.log(`[parity:run] ${engine} ▶ ${name}`);
    /** A derived, order-independent observation (e.g. the outcome set of parallel requests). */
    const record = (label, value) => steps.push({ label, recorded: scrub(value) });
    await mod.default({ step, record, state, engine, api });
  }
} catch (e) {
  failed = e;
  console.error(`[parity:run] ${engine} scenario error: ${e.stack ?? e}`);
} finally {
  try {
    const tables = await readTables(handle);
    mkdirSync(join(here, "out", "raw"), { recursive: true });
    writeFileSync(join(here, "out", "raw", `${engine}.raw`), JSON.stringify({ transcript, tables }));
    const canon = canonicalize({ transcript, tables });
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "api"), { recursive: true });
    mkdirSync(join(out, "tables"), { recursive: true });
    for (const [k, v] of Object.entries(canon.transcript)) writeFileSync(join(out, "api", `${k}.json`), JSON.stringify(v, null, 2));
    for (const [k, v] of Object.entries(canon.tables)) writeFileSync(join(out, "tables", `${k}.json`), JSON.stringify(v, null, 2));
    writeFileSync(join(out, "backend.log"), handle.log());
  } finally {
    await handle.stop();
  }
}
if (failed) process.exit(1);
console.log(`[parity:run] ${engine} done → ${out}`);

/** Opaque/volatile response fields: presence is compared, value is not. */
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (["requestId", "accessToken", "refreshToken", "token", "durationMs", "elapsedMs", "generatedAt", "serverTime"].includes(k)) o[k] = x == null ? x : "<volatile>";
      else if (/cursor$/i.test(k)) o[k] = x == null ? x : "<cursor>";
      else o[k] = scrub(x);
    }
    return o;
  }
  return v;
}
function scrubPath(p) {
  return p.replace(/([?&]cursor=)[^&]*/, "$1<cursor>");
}
