// IPC parity (audit C-01): a command the UI invokes must be registered (main.rs generate_handler!),
// declared in the app manifest (build.rs APP_COMMANDS) and granted to the window
// (capabilities/default.json). Missing from any of the three, Tauri refuses the call at runtime
// ("not allowed by ACL") while every unit test stays green.
//
//   node --test desktop-app/scripts/ipc-acl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(APP, "..");
const read = (p) => readFileSync(p, "utf8");

const handlers = [
  ...read(join(APP, "src-tauri", "src", "main.rs"))
    .match(/generate_handler!\[([^\]]*)\]/)[1]
    .matchAll(/commands::([a-z_]+)/g),
].map((m) => m[1]);
const manifest = [
  ...read(join(APP, "src-tauri", "build.rs"))
    .match(/APP_COMMANDS: &\[&str\] = &\[([^\]]*)\]/)[1]
    .matchAll(/"([a-z_]+)"/g),
].map((m) => m[1]);
const granted = JSON.parse(read(join(APP, "src-tauri", "capabilities", "default.json")))
  .permissions.filter((p) => p.startsWith("allow-"))
  .map((p) => p.slice("allow-".length).replace(/-/g, "_"));

const sources = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|js)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
const invoked = new Map();
for (const file of [...sources(join(ROOT, "src")), ...sources(join(APP, "src-tauri", "pages"))]) {
  for (const m of read(file).matchAll(/invoke\(\s*["']([a-z_]+)["']/g)) invoked.set(m[1], file);
}

const sorted = (a) => [...new Set(a)].sort();

test("the app manifest and the capability list exactly the registered handlers", () => {
  assert.ok(handlers.length > 10, "parsed main.rs");
  assert.deepEqual(sorted(manifest), sorted(handlers), "build.rs APP_COMMANDS ≠ generate_handler!");
  assert.deepEqual(sorted(granted), sorted(handlers), "capability allow-* ≠ generate_handler!");
});

test("every command the UI or the boot page invokes is registered and granted", () => {
  assert.ok(invoked.has("api") && invoked.has("boot_status"), "parsed the callers");
  const missing = [...invoked].filter(([cmd]) => !handlers.includes(cmd));
  assert.deepEqual(missing, [], "invoked but not registered");
});

test("the Drive link and backup picker are among them (C-01 / C-04)", () => {
  for (const cmd of [
    "pick_backup_file",
    "google_status_cmd",
    "google_configure_cmd",
    "google_connect_start_cmd",
    "google_connect_finish_cmd",
    "google_disconnect_cmd",
  ]) {
    assert.ok(handlers.includes(cmd) && granted.includes(cmd), cmd);
  }
});
