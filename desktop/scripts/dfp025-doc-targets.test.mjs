import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("DFP-025 BUILD-WINDOWS.md documents msi+nsis and ar-SA wix language", () => {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  const doc = readFileSync(resolve(root, "BUILD-WINDOWS.md"), "utf8");

  assert.deepEqual(conf.bundle.targets, ["msi", "nsis"]);
  assert.deepEqual(conf.bundle.windows.wix.language, ["ar-SA"]);
  assert.match(doc, /"targets":\s*\["msi",\s*"nsis"\]/);
  assert.match(doc, /nsis\/\*\.exe/);
  assert.match(doc, /ar-SA/);
  assert.doesNotMatch(doc, /targets": \["msi"\] فقط/);
});
