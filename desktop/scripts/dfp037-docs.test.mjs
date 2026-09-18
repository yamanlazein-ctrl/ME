/**
 * DFP-037 — release docs must not claim unproven customer readiness.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("DFP-037 BUILD-WINDOWS documents msi+nsis and honest icon placeholder", () => {
  const doc = readFileSync(resolve(root, "desktop/BUILD-WINDOWS.md"), "utf8");
  const conf = JSON.parse(
    readFileSync(resolve(root, "desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  assert.deepEqual(conf.bundle.targets, ["msi", "nsis"]);
  assert.match(doc, /msi/i);
  assert.match(doc, /nsis/i);
  assert.match(doc, /placeholder/i);
  assert.doesNotMatch(doc, /targets": \["msi"\] فقط/);
  assert.doesNotMatch(doc, /customer-ready|جاهز للعميل|production-ready/i);
});

test("DFP-037 README declares npm+Node 22 and no embedded admin123", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.match(readme, /Node 22/);
  assert.match(readme, /package-lock\.json/);
  assert.doesNotMatch(readme, /admin123|Admin@12345/);
  assert.doesNotMatch(readme, /^# .*Production Ready/m);
  assert.match(readme, /Do not use `bun\.lock`/);
  assert.match(readme, /DESKTOP-FORENSIC-FIX-PLAN/);
});

test("DFP-037 forensic plan marks clean-machine lifecycle as BLOCKED when unproven", () => {
  const plan = readFileSync(resolve(root, "docs/DESKTOP-FORENSIC-FIX-PLAN.md"), "utf8");
  assert.match(plan, /### DFP-004[\s\S]*?\*\*Status:\*\* BLOCKED/);
  assert.match(plan, /### DFP-027[\s\S]*?\*\*Status:\*\* BLOCKED/);
});
