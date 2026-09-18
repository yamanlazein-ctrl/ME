/**
 * DFP-008 — CI must hard-gate Desktop release prerequisites (no advisory-only).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

test("DFP-008 CI gates typecheck, build, resources, security, windows desktop", () => {
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /typecheck:backend/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /validate-resource-manifest/);
  assert.match(ci, /semgrep scan/);
  assert.match(ci, /desktop-windows:/);
  assert.match(ci, /stage-node-runtime/);
  assert.match(ci, /boot_lifecycle|kill_and_wait/);
});

test("DFP-008 CI gates API smoke and forbids soft-continue on security", () => {
  assert.match(ci, /test:api|comprehensive-api|API smoke/);
  // Security step must not be advisory-only continue-on-error: true
  const semgrepBlock = ci.slice(ci.indexOf("Semgrep security gate"));
  const nextJob = semgrepBlock.indexOf("\n  ");
  const block = semgrepBlock.slice(0, nextJob > 0 ? nextJob : 800);
  assert.doesNotMatch(block, /continue-on-error:\s*true/);
});
