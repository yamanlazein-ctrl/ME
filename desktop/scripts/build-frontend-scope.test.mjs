/**
 * Regression: build-frontend.cmd stripped source maps with `del /s /q resources\*.map`, which also matches
 * PostgreSQL's catalog files (global/pg_filenode.map, base/<oid>/pg_filenode.map) inside the packaged
 * pgdata-template and silently corrupted the database whenever it ran after the template was built
 * ("could not open file global/pg_filenode.map" on first start).
 * Source-map handling must be confined to the SSR frontend tree.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cmd = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "build-frontend.cmd"), "utf8");
// Compare with forward slashes so the assertions need no backslash escaping.
const lines = cmd
  .split(/\r?\n/)
  .filter((l) => !/^\s*rem\b/i.test(l))
  .map((l) => l.replaceAll("\\", "/"));

test("source-map stripping never touches anything outside resources/server/web", () => {
  const mapLines = lines.filter((l) => /\*\.map/i.test(l));
  assert.ok(mapLines.length > 0, "expected source-map handling in build-frontend.cmd");
  for (const l of mapLines) {
    assert.ok(l.includes("src-tauri/resources/server/web"), `map handling must be scoped to resources/server/web: ${l.trim()}`);
    assert.ok(!l.includes("resources/*.map"), `unscoped resources/*.map glob: ${l.trim()}`);
  }
});

test("build-frontend.cmd does not delete or move the postgres tree", () => {
  for (const l of lines) {
    if (/\b(del|rmdir|rd|move|robocopy)\b/i.test(l)) {
      assert.ok(!l.includes("resources/postgres"), `must not touch resources/postgres: ${l.trim()}`);
    }
  }
});
