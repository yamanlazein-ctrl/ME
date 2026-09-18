/**
 * validate-resource-manifest.test.mjs — regression for DFP-001 hard gate.
 *
 * Runs the validator against a temporary fixture tree so CI can prove:
 *   - missing required path → exit 1
 *   - zero-byte required file → exit 1
 *   - complete tree → exit 0
 *
 * Invoked via: node --test desktop/scripts/validate-resource-manifest.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(HERE, "validate-resource-manifest.mjs");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "resource-manifest.json"), "utf8"));

function runValidator(resourcesDir) {
  return spawnSync(process.execPath, [VALIDATOR, "--resources", resourcesDir], {
    encoding: "utf8",
  });
}

function populateComplete(root) {
  for (const entry of MANIFEST.required) {
    const full = join(root, entry.path);
    if (entry.kind === "dir") {
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, ".keep"), "x");
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, "non-empty");
    }
  }
}

test("complete resource tree passes", () => {
  const root = mkdtempSync(join(tmpdir(), "dfp001-ok-"));
  try {
    populateComplete(root);
    const r = runValidator(root);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /OK:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing required path fails", () => {
  const root = mkdtempSync(join(tmpdir(), "dfp001-miss-"));
  try {
    populateComplete(root);
    rmSync(join(root, "node.exe"), { force: true });
    const r = runValidator(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing:/);
    assert.match(r.stderr, /node\.exe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero-byte required file fails", () => {
  const root = mkdtempSync(join(tmpdir(), "dfp001-empty-"));
  try {
    populateComplete(root);
    writeFileSync(join(root, "ssr", "serve.mjs"), "");
    const r = runValidator(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /empty/);
    assert.match(r.stderr, /serve\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
