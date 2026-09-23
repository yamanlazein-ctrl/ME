import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("DFP-025 the installer is a per-user NSIS setup (no MSI, no UAC) and BUILD-WINDOWS.md says so", () => {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  const doc = readFileSync(resolve(root, "BUILD-WINDOWS.md"), "utf8");

  // MSI registers/rollback-protects every file separately; NSIS is the fast, per-user installer.
  assert.deepEqual(conf.bundle.targets, ["nsis"]);
  assert.equal(conf.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(conf.bundle.windows.wix, undefined);
  assert.match(doc, /nsis/i);
  assert.match(doc, /currentUser|per-user|بدون صلاحيات/);
});
