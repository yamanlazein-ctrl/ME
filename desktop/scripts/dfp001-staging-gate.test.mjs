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

test("DFP-001 before-build stages node/ssr/backend and validates manifest", () => {
  assert.match(before, /stage-node-runtime/);
  assert.match(before, /stage-ssr|build-frontend/);
  assert.match(before, /stage-backend/);
  assert.match(before, /validate-resource-manifest/);
});

test("DFP-001 tauri resources declare node, ssr, backend, postgres", () => {
  const keys = Object.keys(conf.bundle?.resources ?? {});
  assert.ok(keys.some((k) => k.includes("node.exe")));
  assert.ok(keys.some((k) => k.includes("ssr")));
  assert.ok(keys.some((k) => k.includes("backend")));
  assert.ok(keys.some((k) => k.includes("postgres")));
});
