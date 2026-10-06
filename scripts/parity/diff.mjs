#!/usr/bin/env node
/**
 * Parity diff: compare two canonical export directories produced by run.mjs.
 *
 *   node scripts/parity/diff.mjs <refDir> <sutDir>
 *
 * Every `.json` file present in either directory must exist in both and be
 * deep-equal. Exits 0 only on an empty diff; prints each difference and exits 1
 * otherwise (specs/001-desktop-sqlite-engine, AC-3 / SC-001).
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

function listJson(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".json")) out.push(relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

function diffValues(a, b, path, out) {
  if (Object.is(a, b)) return;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) {
    out.push(`${path}: type ${ta} ≠ ${tb}`);
    return;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffValues(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (!(k in a)) out.push(`${path}.${k}: missing in ref`);
      else if (!(k in b)) out.push(`${path}.${k}: missing in sut`);
      else diffValues(a[k], b[k], `${path}.${k}`, out);
    }
    return;
  }
  out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

const [refDir, sutDir] = process.argv.slice(2);
if (!refDir || !sutDir) {
  console.error("usage: node scripts/parity/diff.mjs <refDir> <sutDir>");
  process.exit(2);
}
for (const d of [refDir, sutDir]) {
  if (!existsSync(d)) {
    console.error(`[parity:diff] directory not found: ${d}`);
    process.exit(2);
  }
}

const files = [...new Set([...listJson(refDir), ...listJson(sutDir)])].sort();
const problems = [];
for (const f of files) {
  const ra = join(refDir, f);
  const sb = join(sutDir, f);
  if (!existsSync(ra)) { problems.push(`${f}: missing in ref`); continue; }
  if (!existsSync(sb)) { problems.push(`${f}: missing in sut`); continue; }
  const diffs = [];
  diffValues(JSON.parse(readFileSync(ra, "utf8")), JSON.parse(readFileSync(sb, "utf8")), "$", diffs);
  for (const d of diffs) problems.push(`${f} ${d}`);
}

if (files.length === 0) {
  console.error("[parity:diff] no export files found — refusing to report an empty diff");
  process.exit(1);
}
if (problems.length) {
  for (const p of problems.slice(0, 500)) console.log(p);
  if (problems.length > 500) console.log(`… and ${problems.length - 500} more`);
  console.log(`[parity:diff] FAIL — ${problems.length} difference(s) across ${files.length} file(s)`);
  process.exit(1);
}
console.log(`[parity:diff] PASS — empty diff across ${files.length} file(s)`);
