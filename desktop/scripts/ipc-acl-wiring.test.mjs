// DT-06: a command registered in `generate_handler!` but missing from build.rs APP_COMMANDS (or never
// granted by a capability) is rejected at runtime with "Command … not allowed by ACL" — that silently
// broke restore-from-file (`pick_backup_file`) and the whole Google Drive screen in the shipped build,
// while every mocked test stayed green. This guards the wiring, which only the real webview exercises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tauri = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");

const handler = [...readFileSync(join(tauri, "src", "main.rs"), "utf8").matchAll(/generate_handler!\[([\s\S]*?)\]/g)]
  .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
const manifest = [...readFileSync(join(tauri, "build.rs"), "utf8").match(/APP_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(
  (m) => m[1],
);
const granted = new Set(
  readdirSync(join(tauri, "capabilities"))
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(tauri, "capabilities", f), "utf8")).permissions),
);

test("every registered command is in the app manifest", () => {
  assert.ok(handler.length > 10, "parsed generate_handler!");
  assert.deepEqual(handler.filter((c) => !manifest.includes(c)), []);
});

test("every registered command is granted by a capability", () => {
  assert.deepEqual(handler.filter((c) => !granted.has(`allow-${c.replaceAll("_", "-")}`)), []);
});

test("the manifest lists no command that is not registered", () => {
  assert.deepEqual(manifest.filter((c) => !handler.includes(c)), []);
});

test("the Google access token is never exposed to the webview (the shell pushes it to the sidecar)", () => {
  assert.ok(!handler.some((c) => c.includes("access_token")));
});
