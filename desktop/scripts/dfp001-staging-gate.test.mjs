/**
 * DFP-001 — before-build must hard-gate a complete, SQLite-only resource tree
 * (specs/001-desktop-sqlite-engine US2: no PostgreSQL is packaged).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const before = readFileSync(resolve(root, "src-tauri/before-build.cmd"), "utf8");
const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));

test("DFP-001 before-build stages node, the SPA and the bundled server, then validates the manifest", () => {
  assert.match(before, /stage-node-runtime/);
  assert.match(before, /build-frontend/);
  assert.match(before, /bundle-server/);
  assert.match(before, /validate-resource-manifest/);
  // The old topology must not come back: no SSR server, no backend node_modules tree.
  assert.doesNotMatch(before, /stage-ssr|sync-ssr-deps|stage-backend/);
});

test("DFP-001 tauri resources declare exactly node, server and the license key (no postgres)", () => {
  assert.deepEqual(Object.values(conf.bundle?.resources ?? {}).sort(), ["license-public.pem", "node.exe", "server"]);
});

test("before-build never builds, prunes or verifies a PostgreSQL template any more", () => {
  for (const gone of ["build-pgdata-template", "verify-pgdata-template", "prune-postgres", "pgdump-staging"]) {
    assert.ok(!before.includes(gone), `${gone} must not run`);
  }
});

test("order: bundle → desktop seed → server-bundle e2e → manifest gate → no-postgres gate → freshness", () => {
  const at = (s) => before.indexOf(s);
  const steps = ["bundle-server.mjs", "build-desktop-seed.mjs", "server-bundle.test.mjs", "validate-resource-manifest.mjs", "verify-no-postgres.mjs", "verify-build-freshness.mjs"];
  for (const s of steps) assert.ok(at(s) > 0, `${s} must run`);
  for (let i = 1; i < steps.length; i++) assert.ok(at(steps[i - 1]) < at(steps[i]), `${steps[i - 1]} before ${steps[i]}`);
});
