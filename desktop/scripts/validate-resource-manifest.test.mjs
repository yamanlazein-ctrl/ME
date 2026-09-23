/**
 * validate-resource-manifest.test.mjs — regression for DFP-001 / Phase 7.
 *
 * Runs the validator against a temporary fixture tree so CI can prove:
 *   - missing required path → exit 1
 *   - zero-byte required file → exit 1
 *   - sha256 mismatch (corrupted byte) → exit 1
 *   - complete tree with matching hashes → exit 0
 *
 * Invoked via: node --test desktop/scripts/validate-resource-manifest.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function runValidator(resourcesDir, manifestPath) {
  const args = [VALIDATOR, "--resources", resourcesDir];
  if (manifestPath) args.push("--manifest", manifestPath);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
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
    writeFileSync(join(root, "server", "server.mjs"), "");
    const r = runValidator(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /empty/);
    assert.match(r.stderr, /server\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupting one byte fails sha256 validation", () => {
  const root = mkdtempSync(join(tmpdir(), "dfp001-hash-"));
  const manPath = join(root, "manifest.json");
  try {
    const payload = "integrity-payload-v1";
    const good = createHash("sha256").update(payload).digest("hex");
    const mini = {
      version: 2,
      required: [{ path: "sealed.txt", kind: "file", sha256: good }],
    };
    writeFileSync(manPath, JSON.stringify(mini));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "sealed.txt"), payload);
    assert.equal(runValidator(root, manPath).status, 0);

    // Flip one byte → digest must fail.
    writeFileSync(join(root, "sealed.txt"), "integrity-payload-v2");
    const bad = runValidator(root, manPath);
    assert.equal(bad.status, 1, bad.stderr || bad.stdout);
    assert.match(bad.stderr, /sha256 mismatch/);
    assert.match(bad.stderr, /sealed\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
