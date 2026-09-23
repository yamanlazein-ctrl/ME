#!/usr/bin/env node
/**
 * build-pgdata-template.mjs — builds the CLEAN desktop database template.
 *
 * Pipeline (fails loudly at any step; never leaves a half-built template in place):
 *   1. initdb a brand-new cluster with the BUNDLED PostgreSQL (UTF8, locale C, UTC).
 *   2. start it on a free localhost port, createdb `erp`.
 *   3. apply EVERY drizzle migration (backend/scripts/migrate.mjs).
 *   4. clean seed ONLY: one tenant + one admin user (backend/src/scripts/seed.ts).
 *   5. bake the signed desktop license (backend/src/scripts/bake-desktop-license.ts).
 *   6. assert: migrations applied == journal, every business table has 0 rows,
 *      document_sequences is empty (so the first invoice is number 1).
 *   7. stop PostgreSQL with `pg_ctl stop -m smart` (clean checkpoint, NOT immediate).
 *   8. replace resources/postgres/pgdata-template and write pgdata-template.manifest.json.
 *   9. re-verify the shipped copy (verify-pgdata-template.mjs).
 *
 * Required environment:
 *   DESKTOP_ADMIN_PASSWORD   initial admin password (min 12 chars) — never stored, only its Argon2 hash.
 *   LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY   (or present in backend/.env) — signs the license.
 * Optional:
 *   DESKTOP_LICENSE_KEY      license key string (default: LIC-DESKTOP-<16 hex>)
 *   BAKED_LICENSE_DEVICES    device cap (default 1)
 *
 * The tenant id is read from build-frontend.cmd (VITE_DEFAULT_TENANT_ID) so the frontend
 * and the database can never disagree.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKEND_ROOT,
  DB_NAME,
  DB_SUPERUSER,
  REPO_ROOT,
  TEMPLATE_DIR,
  TEMPLATE_MANIFEST,
  assertCleanSeed,
  databaseUrl,
  freePort,
  pgTool,
  run,
  startPostgres,
  stopPostgresClean,
  withClient,
} from "./pgdata-template-lib.mjs";

const log = (m) => console.log(`[pgdata-template] ${m}`);
// `fail` THROWS (never process.exit): an exit inside the build would skip cleanup and leave the temporary
// PostgreSQL server running. The handler below reports the message and sets the exit code.
const fail = (m) => {
  throw new Error(m);
};
process.on("uncaughtException", (e) => {
  console.error(`[pgdata-template] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

// ── inputs ───────────────────────────────────────────────────────────────────
const adminPassword = process.env.DESKTOP_ADMIN_PASSWORD?.trim();
if (!adminPassword || adminPassword.length < 12) {
  fail("DESKTOP_ADMIN_PASSWORD is required (min 12 characters). It is hashed into the template and never stored.");
}

const frontendCmd = readFileSync(join(REPO_ROOT, "desktop", "build-frontend.cmd"), "utf8");
const tenantId = /set\s+"VITE_DEFAULT_TENANT_ID=([0-9a-f-]{36})"/i.exec(frontendCmd)?.[1];
if (!tenantId) fail("could not read VITE_DEFAULT_TENANT_ID from desktop/build-frontend.cmd");

function readSigningKeys() {
  let priv = process.env.LICENSE_SIGNING_KEY?.trim();
  let pub = process.env.LICENSE_SIGNING_PUBLIC_KEY?.trim();
  if ((!priv || !pub) && existsSync(join(BACKEND_ROOT, ".env"))) {
    const env = readFileSync(join(BACKEND_ROOT, ".env"), "utf8");
    const pick = (name) => {
      const m = new RegExp(`^${name}=(.*)$`, "m").exec(env);
      return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
    };
    priv ||= pick("LICENSE_SIGNING_KEY");
    pub ||= pick("LICENSE_SIGNING_PUBLIC_KEY");
  }
  if (!priv || !pub) fail("LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY not found (env or backend/.env)");
  const nl = (s) => s.replace(/\\n/g, "\n");
  return { priv: nl(priv), pub: nl(pub) };
}
const keys = readSigningKeys();

// The shipped public key must be the pair of the signing key, or no customer could verify the license.
const shippedPem = readFileSync(join(REPO_ROOT, "desktop", "src-tauri", "resources", "license-public.pem"), "utf8");
const strip = (s) => s.replace(/-----[^-]+-----|\s+/g, "");
if (strip(shippedPem) !== strip(keys.pub)) {
  fail("resources/license-public.pem does not match LICENSE_SIGNING_PUBLIC_KEY — the baked license would not verify on the customer machine");
}

const licenseKey = process.env.DESKTOP_LICENSE_KEY?.trim() || `LIC-DESKTOP-${randomBytes(8).toString("hex").toUpperCase()}`;
const devices = String(process.env.BAKED_LICENSE_DEVICES ?? "1");

// ── build ────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "motard-template-"));
const pgdata = join(work, "pgdata");
let started = false;
const cleanup = () => {
  if (started) {
    try {
      stopPostgresClean(pgdata);
    } catch {
      /* best effort */
    }
  }
  rmSync(work, { recursive: true, force: true });
};

try {
  log(`workdir ${work}`);
  log("initdb (UTF8, locale C, trust bootstrap — runtime hardens to scram on first start)");
  run(pgTool("initdb"), ["-D", pgdata, "-U", DB_SUPERUSER, "-E", "UTF8", "--locale=C", "--auth=trust"]);
  // Deterministic server timezone: builds must not depend on the build machine's zone.
  writeFileSync(join(pgdata, "postgresql.conf"), `\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n`, { flag: "a" });

  const port = await freePort();
  const pgLog = join(work, "pg.log");
  startPostgres(pgdata, port, pgLog);
  started = true;
  log(`postgres started on 127.0.0.1:${port}`);

  run(pgTool("createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", DB_SUPERUSER, DB_NAME]);
  const url = databaseUrl(port);

  const tsx = join(BACKEND_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const backendEnv = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: url,
    JWT_SECRET: randomBytes(48).toString("hex"),
    APP_MASTER_KEY: randomBytes(32).toString("base64"),
    LICENSE_SIGNING_KEY: keys.priv,
    LICENSE_SIGNING_PUBLIC_KEY: keys.pub,
    SEED_TENANT_ID: tenantId,
    SEED_ADMIN_PASSWORD: adminPassword,
    BAKED_LICENSE_KEY: licenseKey,
    BAKED_LICENSE_DEVICES: devices,
    LOG_LEVEL: "warn",
  };
  const step = (name, args) => {
    log(name);
    const r = spawnSync(process.execPath, args, { cwd: BACKEND_ROOT, env: backendEnv, encoding: "utf8", windowsHide: true });
    if (r.status !== 0) fail(`${name} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };

  step("apply all migrations", [join(BACKEND_ROOT, "scripts", "migrate.mjs")]);
  step("seed: company + admin only", [tsx, "src/scripts/seed.ts"]);
  step("bake signed desktop license", [tsx, "src/scripts/bake-desktop-license.ts"]);

  log("asserting migrated + clean + empty sequences");
  const summary = await assertCleanSeed(url, { expectTenantId: tenantId });
  const seq = await withClient(url, (c) => c.query("SELECT count(*)::int AS n FROM document_sequences"));
  if (seq.rows[0].n !== 0) fail("document_sequences is not empty");
  log(`OK — ${summary.migrationsApplied}/${summary.journalEntries} migrations, ${summary.tableCount} tables, rows: ${JSON.stringify(summary.nonEmpty)}`);

  log("clean shutdown (pg_ctl stop -m smart)");
  stopPostgresClean(pgdata);
  started = false;
  if (existsSync(join(pgdata, "postmaster.pid"))) fail("postmaster.pid still present after clean stop");
  for (const stale of ["postmaster.opts", "current_logfiles"]) rmSync(join(pgdata, stale), { force: true });

  // Clean shutdown is proven by verify-pgdata-template.mjs (server log on first open), below.

  // ── install ────────────────────────────────────────────────────────────────
  log(`replacing ${TEMPLATE_DIR}`);
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  cpSync(pgdata, TEMPLATE_DIR, { recursive: true });

  const fileCount = (d) =>
    readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? fileCount(join(d, e.name)) : 1), 0);
  const manifest = {
    builtAt: new Date().toISOString(),
    postgresVersion: run(join(REPO_ROOT, "desktop", "src-tauri", "resources", "postgres", "bin", "postgres.exe"), ["--version"]).stdout.trim(),
    database: DB_NAME,
    tenantId,
    adminEmail: "admin@erp.local",
    license: { key: summary.licenseKey, devices: Number(devices) },
    migrations: { applied: summary.migrationsApplied, journal: summary.journalEntries },
    tables: summary.tableCount,
    nonEmptyTables: summary.nonEmpty,
    documentSequencesRows: 0,
    cleanShutdown: true,
    files: fileCount(TEMPLATE_DIR),
    sizeBytes: (function size(d) {
      return readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
    })(TEMPLATE_DIR),
    controlFileSha256: createHash("sha256").update(readFileSync(join(TEMPLATE_DIR, "global", "pg_control"))).digest("hex"),
  };
  writeFileSync(TEMPLATE_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  log(`template installed (${manifest.files} files, ${(manifest.sizeBytes / 1e6).toFixed(1)} MB)`);
} catch (e) {
  cleanup();
  throw e;
}
cleanup();

// ── re-verify the shipped copy exactly as the release gate will ─────────────────
const v = spawnSync(process.execPath, [join(REPO_ROOT, "desktop", "scripts", "verify-pgdata-template.mjs")], {
  stdio: "inherit",
  windowsHide: true,
});
if (v.status !== 0) fail("verification of the installed template failed");
log(`DONE — license key: ${licenseKey}`);
