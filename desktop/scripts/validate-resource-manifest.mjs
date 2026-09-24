#!/usr/bin/env node
/**
 * validate-resource-manifest.mjs — DFP-001 / Phase 7 hard release gate.
 *
 * Asserts every path in resource-manifest.json exists under
 * desktop/src-tauri/resources and is non-empty (files) / non-empty dir.
 * When an entry carries `sha256` (64 hex), the file digest must match.
 * Mirrors desktop/src-tauri/src/runtime/stack.rs preflight_check().
 *
 * Usage:
 *   node desktop/scripts/validate-resource-manifest.mjs
 *   node desktop/scripts/validate-resource-manifest.mjs --resources <path>
 *   node desktop/scripts/validate-resource-manifest.mjs --manifest <path> --resources <path>
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
 * Every bundled PostgreSQL executable must actually START and report the same
 * version. Existence is not enough: a pg_dump.exe copied from a different
 * 17.x build than the bundled libpq.dll exits with 0xC0000139 (entry point
 * not found), which made every upgrade over existing data refuse to boot
 * ("SNAPSHOT_FAILED: exit 3221225785").
 */
export function checkPostgresToolsRun(resources) {
  const bin = join(resources, "postgres", "bin");
  const tools = ["postgres", "pg_ctl", "initdb", "pg_dump", "pg_restore"];
  const exe = (t) => join(bin, process.platform === "win32" ? `${t}.exe` : t);
  const failures = [];
  const versions = new Map();
  for (const t of tools) {
    const r = spawnSync(exe(t), ["--version"], { encoding: "utf8", windowsHide: true });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const m = /\(PostgreSQL\)\s+(\S+)/.exec(out);
    if (r.status !== 0 || !m) {
      failures.push(`${t}: exit ${r.status ?? r.error?.code ?? "?"} ${out.slice(0, 120)}`);
    } else {
      versions.set(t, m[1]);
    }
  }
  const distinct = new Set(versions.values());
  if (distinct.size > 1) {
    failures.push(`version mismatch: ${[...versions].map(([t, v]) => `${t}=${v}`).join(", ")}`);
  }
  return failures;
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
  const toolFailures = process.argv.includes("--skip-exec-check")
    ? []
    : checkPostgresToolsRun(resources);
  if (toolFailures.length) {
    console.error("[validate-resource-manifest] FAIL: bundled PostgreSQL tools do not run");
    for (const f of toolFailures) console.error(`    - ${f}`);
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
