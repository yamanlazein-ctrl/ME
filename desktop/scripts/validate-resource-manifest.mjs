#!/usr/bin/env node
/**
 * validate-resource-manifest.mjs — DFP-001 / Phase 7 hard release gate.
 *
 * Asserts every path in resource-manifest.json exists under
 * desktop/src-tauri/resources and is non-empty (files) / non-empty dir.
 * When an entry carries `sha256` (64 hex), the file digest must match.
 * Mirrors desktop/src-tauri/src/runtime/stack.rs preflight_check(), loads the bundled SQLite
 * engine with the bundled node.exe, and refuses any PostgreSQL artefact (SQLite-only desktop).
 *
 * Usage:
 *   node desktop/scripts/validate-resource-manifest.mjs
 *   node desktop/scripts/validate-resource-manifest.mjs --resources <path>
 *   node desktop/scripts/validate-resource-manifest.mjs --manifest <path> --resources <path>
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RES = join(HERE, "..", "src-tauri", "resources");
const DEFAULT_MANIFEST = join(HERE, "resource-manifest.json");

function parseArgs(argv) {
  let resources = DEFAULT_RES;
  let manifest = DEFAULT_MANIFEST;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resources" && argv[i + 1]) {
      resources = argv[++i];
    } else if (argv[i] === "--manifest" && argv[i + 1]) {
      manifest = argv[++i];
    }
  }
  return { resources, manifest };
}

function dirNonEmpty(p) {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function isSha256Hex(v) {
  return typeof v === "string" && /^[a-f0-9]{64}$/i.test(v);
}

export function validateManifest(resources, manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const missing = [];
  const empty = [];
  const hashMismatch = [];

  for (const entry of manifest.required) {
    const full = join(resources, entry.path);
    if (!existsSync(full)) {
      missing.push(entry.path);
      continue;
    }
    const st = statSync(full);
    if (entry.kind === "file") {
      if (!st.isFile() || st.size <= 0) {
        empty.push(entry.path);
        continue;
      }
      if (isSha256Hex(entry.sha256)) {
        const actual = sha256File(full);
        if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
          hashMismatch.push({ path: entry.path, expected: entry.sha256, actual });
        }
      }
    } else if (entry.kind === "dir") {
      if (!st.isDirectory() || !dirNonEmpty(full)) empty.push(entry.path);
    }
  }

  return { manifest, missing, empty, hashMismatch };
}

/**
 * The bundled engine must actually LOAD with the bundled runtime: node.exe requires the
 * better-sqlite3 N-API addon from server/node_modules and runs a query in memory. Existence is
 * not enough — an addon built for another Node ABI or architecture fails only at load time, which
 * would make every customer boot fail (specs/001-desktop-sqlite-engine T048).
 */
export function checkSqliteEngineLoads(resources) {
  const node = join(resources, process.platform === "win32" ? "node.exe" : "node");
  const addonDir = resolve(resources, "server", "node_modules", "better-sqlite3");
  const probe =
    "const D=require(process.argv[1]);const d=new D(':memory:');" +
    "const v=d.prepare('select sqlite_version() v').get().v;d.pragma('journal_mode=WAL');" +
    "d.exec('create table t(x integer) strict');d.prepare('insert into t values (?)').run(9007199254740993n);" +
    "console.log(JSON.stringify({v,ok:d.prepare('select x from t').safeIntegers(true).get().x===9007199254740993n}))";
  const r = spawnSync(node, ["-e", probe, addonDir], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return [`bundled node.exe cannot load better-sqlite3: exit ${r.status ?? r.error?.code} ${(r.stderr || "").slice(0, 300)}`];
  try {
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
    return out.ok ? [] : [`better-sqlite3 loaded (SQLite ${out.v}) but lost 64-bit integer precision`];
  } catch {
    return [`unexpected probe output: ${r.stdout.slice(0, 200)}`];
  }
}

/** The desktop is SQLite-only (US2, SC-002): no PostgreSQL artefact may be packaged. */
export function checkNoPostgresArtefacts(resources) {
  const forbidden = /^(postgres\.exe|pg_ctl\.exe|initdb\.exe|pg_dump\.exe|pg_restore\.exe|psql\.exe|libpq.*\.dll|db-port\.txt)$/i;
  const found = [];
  const walk = (dir, rel = "") => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (/^(postgres|pgdata-template|pgdata)$/i.test(e.name)) found.push(`${r}/`);
        else walk(join(dir, e.name), r);
      } else if (forbidden.test(e.name)) found.push(r);
    }
  };
  walk(resources);
  return found;
}

function main() {
  const { resources, manifest: manifestPath } = parseArgs(process.argv.slice(2));
  const { missing, empty, hashMismatch, manifest } = validateManifest(resources, manifestPath);

  if (missing.length || empty.length || hashMismatch.length) {
    console.error("[validate-resource-manifest] FAIL");
    if (missing.length) {
      console.error("  missing:");
      for (const p of missing) console.error(`    - ${p}`);
    }
    if (empty.length) {
      console.error("  empty / zero-byte:");
      for (const p of empty) console.error(`    - ${p}`);
    }
    if (hashMismatch.length) {
      console.error("  sha256 mismatch:");
      for (const h of hashMismatch) {
        console.error(`    - ${h.path}`);
        console.error(`        expected ${h.expected}`);
        console.error(`        actual   ${h.actual}`);
      }
    }
    process.exit(1);
  }

  // --skip-exec-check exists only for unit-test fixtures (dummy files); the
  // release build (before-build.cmd) never passes it.
  const engineFailures = process.argv.includes("--skip-exec-check") ? [] : checkSqliteEngineLoads(resources);
  if (engineFailures.length) {
    console.error("[validate-resource-manifest] FAIL: the bundled SQLite engine does not load");
    for (const f of engineFailures) console.error(`    - ${f}`);
    process.exit(1);
  }

  const pgLeftovers = checkNoPostgresArtefacts(resources);
  if (pgLeftovers.length) {
    console.error("[validate-resource-manifest] FAIL: PostgreSQL artefacts would be packaged (SQLite-only desktop)");
    for (const f of pgLeftovers) console.error(`    - ${f}`);
    process.exit(1);
  }

  const hashed = manifest.required.filter((e) => isSha256Hex(e.sha256)).length;
  console.log(
    `[validate-resource-manifest] OK: ${manifest.required.length} required paths` +
      ` (${hashed} sha256-checked) under ${resources}`,
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, "\\");
// Windows path compare is messy; always run main when not imported for tests.
if (process.argv[1] && process.argv[1].includes("validate-resource-manifest")) {
  main();
}
