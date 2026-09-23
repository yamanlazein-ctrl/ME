/**
 * DFP-036 — source maps must leave the customer resource tree; private symbols
 * land under target/symbols (build machine / CI), not Tauri `resources`.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("DFP-036 build-frontend moves maps to target/symbols and strips the packaged web tree", () => {
  const cmd = readFileSync(resolve(root, "build-frontend.cmd"), "utf8").replaceAll("\\", "/");
  assert.match(cmd, /DFP-036/);
  assert.match(cmd, /target\/symbols/);
  // Scoped to the web tree — an unscoped resources\*.map would also delete PostgreSQL's pg_filenode.map
  // catalog files from the database template (see build-frontend-scope.test.mjs).
  assert.ok(cmd.includes('del /s /q "desktop/src-tauri/resources/server/web/*.map"'));
  assert.match(cmd, /ME_KEEP_SOURCEMAPS/);
});

test("DFP-036 tauri resources do not bundle _symbols", () => {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  const keys = Object.keys(conf.bundle?.resources ?? {});
  assert.ok(!keys.some((k) => k.includes("_symbols") || k.includes("symbols")));
});
