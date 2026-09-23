/**
 * DFP-001 — before-build must hard-gate a complete resource tree.
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

test("DFP-001 tauri resources declare exactly node, server, postgres and the license key", () => {
  assert.deepEqual(Object.values(conf.bundle?.resources ?? {}).sort(), [
    "license-public.pem",
    "node.exe",
    "postgres",
    "server",
  ]);
});

test("before-build rebuilds and verifies the clean pgdata-template BEFORE the manifest gate", () => {
  const build = before.indexOf("build-pgdata-template.mjs");
  const verify = before.indexOf("verify-pgdata-template.mjs");
  const manifest = before.indexOf("validate-resource-manifest.mjs");
  assert.ok(build > 0 && verify > build && manifest > verify, "template build → verify → manifest gate order");
});

test("before-build runs the real server-bundle end-to-end gate before packaging", () => {
  const e2e = before.indexOf("server-bundle.test.mjs");
  assert.ok(e2e > before.indexOf("verify-pgdata-template.mjs"), "e2e gate runs after the template exists");
  assert.ok(e2e < before.indexOf("validate-resource-manifest.mjs"));
});
