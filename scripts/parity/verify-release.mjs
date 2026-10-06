#!/usr/bin/env node
/**
 * Release-candidate verification (specs/001-desktop-sqlite-engine T116/T122; FR-040, DB-8, SC-002).
 *
 *   node scripts/parity/verify-release.mjs [--installer <setup.exe>] [--out scripts/parity/out/release]
 *
 * Works on the exact runtime tree the installer is packed from (desktop/src-tauri/target/release),
 * which the build's freshness gate ties to the installer byte for byte — the installer itself is
 * never installed on this machine. Checks:
 *   1. installer identity (sha256, size, version) and the post-build freshness gate;
 *   2. no PostgreSQL artefact in the packaged resources or runtime tree (verify-no-postgres.mjs);
 *   3. the packaged node.exe + server/server.mjs, started as the desktop runtime starts it
 *      (DB_ENGINE=sqlite, FRESH, desktop deploy), with V8 coverage on:
 *        - onboarding, a sale invoice and a VERIFIED v3 backup work;
 *        - a REAL PostgreSQL-era (v2) backup, exported by the PostgreSQL backend, is refused with the
 *          "PostgreSQL-era backup" message (BACKUP_UNSUPPORTED_FORMAT);
 *        - after a graceful shutdown (/api/desktop/runtime/shutdown), no function inside the bundled
 *          PostgreSQL client modules (pg, pg-pool, pg-protocol, pg-connection-string, pgpass,
 *          drizzle-orm/node-postgres) or orm/drizzle.ts ever executed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiClient, provisionCompany, ensureSeed, startEngine, TENANT_ID } from "./lib/engine.mjs";
import { pgAdminUrl } from "./lib/syncAc8.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const DESKTOP = join(REPO, "desktop");
const RUNTIME = join(DESKTOP, "src-tauri", "target", "release");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const OUT = resolve(REPO, arg("out", "scripts/parity/out/release"));
mkdirSync(OUT, { recursive: true });
const nsisDir = join(RUNTIME, "bundle", "nsis");
const installer = arg("installer") ?? join(nsisDir, readdirSync(nsisDir).filter((f) => f.endsWith("-setup.exe")).map((f) => ({ f, t: statSync(join(nsisDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f);
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── 1. identity + freshness ──
const bytes = readFileSync(installer);
const identity = { file: installer, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), version: JSON.parse(readFileSync(join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8")).version };
console.log(`[verify-release] ${identity.file}\n  sha256 ${identity.sha256}  (${identity.sizeBytes} bytes, v${identity.version})`);
{
  const r = spawnSync(process.execPath, [join(DESKTOP, "scripts", "verify-build-freshness.mjs"), "post", "release"], { cwd: DESKTOP, encoding: "utf8" });
  check("build freshness gate: runtime tree = resources, exe embeds current web, installer newer than exe", r.status === 0, (r.stdout + r.stderr).trim().split("\n").at(-1));
}
// ── 2. no PostgreSQL artefacts ──
for (const [label, dir] of [["packaged resources", join(DESKTOP, "src-tauri", "resources")], ["runtime tree (exe, node.exe, server/)", RUNTIME]]) {
  const r = spawnSync(process.execPath, [join(DESKTOP, "scripts", "verify-no-postgres.mjs"), dir], { encoding: "utf8" });
  check(`no PostgreSQL binary, pgdata template or port file in the ${label}`, r.status === 0, (r.stdout + r.stderr).trim().split("\n").at(-1));
}

// ── 3a. a real PostgreSQL-era (v2) backup, from the PostgreSQL backend ──
const v2Path = join(OUT, "postgres-era-v2.zip");
{
  const seed = ensureSeed(join(here, "out", "desktop-seed.json"));
  const pg = await startEngine("postgres", { port: 18501, seedPath: seed, pgAdminUrl: pgAdminUrl() });
  try {
    const api = apiClient(pg.base);
    await provisionCompany(api);
    const login = await api.call("POST", "/api/auth/login", { email: "admin@erp.local", password: "Parity-Pass-2026!", tenantId: TENANT_ID });
    const r = await fetch(`${pg.base}/api/backup/full`, { method: "POST", headers: { Authorization: `Bearer ${login.body.accessToken}`, "Idempotency-Key": randomUUID() } });
    const zip = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200 || zip.length < 100) throw new Error(`v2 export failed: HTTP ${r.status}`);
    writeFileSync(v2Path, zip);
  } finally {
    await pg.stop();
  }
}

// ── 3b. the packaged server, with coverage ──
const work = mkdtempSync(join(tmpdir(), "motard-release-"));
const coverageDir = join(work, "coverage");
mkdirSync(coverageDir, { recursive: true });
// The build's own seed (signed with the release licence key it ships with), as in the field.
const seedPath = join(RUNTIME, "server", "desktop-seed.json");
const packagedTenant = JSON.parse(readFileSync(seedPath, "utf8")).tenant.id;
const APP_MASTER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
const PORT = 18502;
const env = {
  ...process.env, NODE_ENV: "production", PORT: String(PORT), HOST: "127.0.0.1", DESKTOP_DEPLOY: "true", DB_ENGINE: "sqlite",
  SQLITE_PATH: join(work, "data", "motard.db"), MOTARD_STARTUP_STATE: "FRESH", DESKTOP_SEED_PATH: seedPath,
  MOTARD_INSTALLATION_ID: "00000000-0000-4000-8000-0000000000cc", APP_MASTER_KEY, JWT_SECRET: "release-check-jwt-secret-32-chars-minimum!!",
  LICENSE_SERVER_MODE: "embedded", DEFAULT_TENANT_ID: packagedTenant, LOG_DIR: join(work, "logs"), BACKUP_MIRROR_DIR: "off",
  RATE_LIMIT_RPS: "100000", NODE_V8_COVERAGE: coverageDir,
  // as desktop/src-tauri/src/runtime/stack.rs passes them (an HTTP port instead of the named pipe)
  MOTARD_DATA_ID: randomUUID(), MOTARD_INSTALL_INSTANCE_ID: "release-check-instance", MOTARD_APP_VERSION: identity.version,
  LICENSE_SIGNING_PUBLIC_KEY: readFileSync(join(RUNTIME, "license-public.pem"), "utf8"), COMPANY_LOGO_DIR: join(work, "logos"),
};
for (const k of ["DATABASE_URL", "TEST_DB_URL", "NODE_OPTIONS", "DESKTOP_PIPE"]) delete env[k];
const serverMjs = join(RUNTIME, "server", "server.mjs");
const proc = spawn(join(RUNTIME, "node.exe"), [serverMjs], { cwd: join(RUNTIME, "server"), env, stdio: ["ignore", openSync(join(work, "server.log"), "w"), openSync(join(work, "server.log"), "a")] });
const base = `http://127.0.0.1:${PORT}`;
let exited = false;
proc.on("exit", () => (exited = true));
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health/live`)).ok) break;
    } catch {
      /* starting */
    }
    if (exited || i > 240) throw new Error(`packaged server did not start:\n${readFileSync(join(work, "server.log"), "utf8").slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const api = apiClient(base);
  await provisionCompany(api, packagedTenant);
  const c = await api.call("POST", "/api/customers", { name: "Release Check" });
  const f = await api.call("POST", "/api/inventory/fabrics", { name: "Release Fabric" });
  const co = await api.call("POST", "/api/inventory/colors", { fabricId: f.body.id, name: "Release Color" });
  const ro = await api.call("POST", "/api/inventory/rolls", { colorId: co.body.id, rollNo: "REL-1", initialKg: 100, pieces: 10, pricePerKg: 2, currency: "USD", entryDate: "2026-10-05" });
  const inv = await api.call("POST", "/api/invoices", { type: "sale", date: "2026-10-05", partyId: c.body.id, partyType: "customer", currency: "USD", lines: [{ fabricId: f.body.id, colorId: co.body.id, rollId: ro.body.id, quantityKg: 5, pieces: 1, pricePerKg: 4 }], paid: 0 });
  check("packaged server (SQLite, desktop mode): onboarding + sale invoice", inv.status === 201, `HTTP ${inv.status}`);
  const bk = await api.call("POST", "/api/backup/full?deliver=metadata");
  check("packaged server: manual backup is a VERIFIED v3 archive", bk.status === 200 && bk.body?.status === "VERIFIED", JSON.stringify({ status: bk.status, state: bk.body?.status }));
  const login = await api.call("POST", "/api/auth/login", { email: "admin@erp.local", password: "Parity-Pass-2026!", tenantId: packagedTenant });
  const rr = await fetch(`${base}/api/backup/restore?confirm=replace`, { method: "POST", headers: { Authorization: `Bearer ${login.body.accessToken}`, "Content-Type": "application/zip", "Idempotency-Key": randomUUID() }, body: readFileSync(v2Path) });
  const rb = await rr.json().catch(() => ({}));
  check("packaged server refuses a real PostgreSQL-era (v2) backup with the PostgreSQL-era message", rr.status === 422 && rb.code === "BACKUP_UNSUPPORTED_FORMAT" && /PostgreSQL/.test(rb.message ?? ""), `HTTP ${rr.status} ${rb.code} «${rb.message}»`);
  const sd = await fetch(`${base}/api/desktop/runtime/shutdown`, { method: "POST", headers: { "x-motard-runtime-token": createHash("sha256").update(APP_MASTER_KEY).digest("hex") } });
  check("graceful shutdown through the runtime hand-off endpoint", sd.ok, `HTTP ${sd.status}`);
  for (let i = 0; i < 60 && !exited; i++) await new Promise((r) => setTimeout(r, 250));
} finally {
  if (!exited) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}

// ── 3c. coverage: nothing in the PostgreSQL client modules executed ──
const PG_MODULE = /\/\/ backend\/(node_modules\/(pg|pg-pool|pg-protocol|pg-connection-string|pgpass|pg-cloudflare)\/|node_modules\/drizzle-orm\/node-postgres\/|src\/infrastructure\/orm\/drizzle\.ts)/;
const source = readFileSync(serverMjs, "utf8");
const regions = [];
{
  const re = /^\/\/ (backend\/|packages\/)[^\n]*$/gm;
  const marks = [];
  for (let m; (m = re.exec(source)); ) marks.push({ at: m.index, line: m[0] });
  marks.forEach((m, i) => {
    if (PG_MODULE.test(m.line)) regions.push({ module: m.line.slice(3), start: m.at, end: i + 1 < marks.length ? marks[i + 1].at : source.length });
  });
}
const covFiles = existsSync(coverageDir) ? readdirSync(coverageDir).filter((f) => f.endsWith(".json")) : [];
let scriptCov = null;
for (const f of covFiles) {
  const data = JSON.parse(readFileSync(join(coverageDir, f), "utf8"));
  scriptCov ??= data.result.find((s) => s.url && s.url.toLowerCase().endsWith("/server/server.mjs"));
}
check("V8 coverage captured for the packaged server.mjs", Boolean(scriptCov), `${covFiles.length} coverage file(s), ${regions.length} PostgreSQL module regions in the bundle`);
// esbuild positions are character offsets; V8 reports UTF-16 offsets too — same unit as String indices.
const executed = [];
for (const fn of scriptCov?.functions ?? []) {
  const range = fn.ranges[0];
  if (!range || range.count === 0) continue;
  const region = regions.find((r) => range.startOffset >= r.start && range.startOffset < r.end);
  if (region) executed.push(`${region.module} :: ${fn.functionName || "(anonymous)"} ×${range.count}`);
}
check("no PostgreSQL client code executed while the packaged desktop ran (FR-040 / DB-8)", Boolean(scriptCov) && executed.length === 0, executed.slice(0, 8).join(" | "));

writeFileSync(join(OUT, "verify-release.json"), JSON.stringify({ generatedAt: new Date().toISOString(), installer: identity, checks, pgRegions: regions.length }, null, 2));
rmSync(work, { recursive: true, force: true });
process.exit(checks.every((c) => c.pass) ? 0 : 1);
