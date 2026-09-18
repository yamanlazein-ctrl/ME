/**
 * DFP-026 — packaged CSP must stay least-privilege (documented exceptions only).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const csp = String(conf.app?.security?.csp ?? "");

test("DFP-026 CSP has no Google Fonts / wildcard connect", () => {
  assert.doesNotMatch(csp, /fonts\.googleapis|fonts\.gstatic/i);
  assert.doesNotMatch(csp, /connect-src[^;]*\*/);
  assert.match(csp, /127\.0\.0\.1:8080/);
  assert.match(csp, /127\.0\.0\.1:4173/);
});

test("DFP-026 documents unavoidable WebView script exceptions in CSP string", () => {
  // Tauri/WebView bootstrap still requires these; connect-src is narrowed above.
  assert.match(csp, /'unsafe-inline'/);
  assert.match(csp, /wasm-unsafe-eval/);
  assert.match(csp, /default-src 'self'/);
});
