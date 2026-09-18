#!/usr/bin/env node
/**
 * validate-resource-manifest.mjs — DFP-001 hard release gate.
 *
 * Asserts every path in resource-manifest.json exists under
 * desktop/src-tauri/resources and is non-empty (files) / non-empty dir.
 * Mirrors desktop/src-tauri/src/runtime/stack.rs preflight_check().
 *
 * Usage:
 *   node desktop/scripts/validate-resource-manifest.mjs
 *   node desktop/scripts/validate-resource-manifest.mjs --resources <path>
 */
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RES = join(HERE, "..", "src-tauri", "resources");
const MANIFEST = join(HERE, "resource-manifest.json");

function parseArgs(argv) {
  let resources = DEFAULT_RES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resources" && argv[i + 1]) {
      resources = argv[++i];
    }
  }
  return { resources };
}

function dirNonEmpty(p) {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function main() {
  const { resources } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const missing = [];
  const empty = [];

  for (const entry of manifest.required) {
    const full = join(resources, entry.path);
    if (!existsSync(full)) {
      missing.push(entry.path);
      continue;
    }
    const st = statSync(full);
    if (entry.kind === "file") {
      if (!st.isFile() || st.size <= 0) empty.push(entry.path);
    } else if (entry.kind === "dir") {
      if (!st.isDirectory() || !dirNonEmpty(full)) empty.push(entry.path);
    }
  }

  if (missing.length || empty.length) {
    console.error("[validate-resource-manifest] FAIL");
    if (missing.length) {
      console.error("  missing:");
      for (const p of missing) console.error(`    - ${p}`);
    }
    if (empty.length) {
      console.error("  empty / zero-byte:");
      for (const p of empty) console.error(`    - ${p}`);
    }
    process.exit(1);
  }

  console.log(
    `[validate-resource-manifest] OK: ${manifest.required.length} required paths present under ${resources}`,
  );
}

main();
