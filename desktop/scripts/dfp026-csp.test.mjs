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

test("DFP-026 CSP has no Google Fonts / wildcard connect / fixed ports", () => {
  assert.doesNotMatch(csp, /fonts\.googleapis|fonts\.gstatic/i);
  assert.doesNotMatch(csp, /connect-src[^;]*\*/);
  // The desktop UI is served by the local server on an OS-assigned port: no fixed port may be baked in.
  assert.doesNotMatch(csp, /:8080|:4173/);
});

test("DFP-026 the only bundled window is the local splash page", () => {
  const labels = (conf.app?.windows ?? []).map((w) => w.label);
  assert.deepEqual(labels, ["splash"], "the main window is created at runtime, once the server port is known");
  assert.match(csp, /default-src 'self'/);
});
