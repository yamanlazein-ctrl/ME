/**
 * Phase 4 — SSR discovers backend port from env or AppData runtime-config.json.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveApiProxy, readRuntimeConfig, DEV_DEFAULT_API } from "./resolve-api-proxy.mjs";

test("resolveApiProxy prefers SSR_API_PROXY over file and default", () => {
  const dir = mkdtempSync(join(tmpdir(), "motard-ssr-"));
  const cfg = join(dir, "runtime-config.json");
  writeFileSync(cfg, JSON.stringify({ backendPort: 18111, apiBaseUrl: "http://127.0.0.1:18111" }));
  assert.equal(
    resolveApiProxy({ SSR_API_PROXY: "http://127.0.0.1:18222/", RUNTIME_CONFIG_PATH: cfg }),
    "http://127.0.0.1:18222",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("resolveApiProxy reads runtime-config.json when env unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "motard-ssr-"));
  const cfg = join(dir, "runtime-config.json");
  writeFileSync(cfg, JSON.stringify({ backendPort: 18333, apiBaseUrl: "http://127.0.0.1:18333" }));
  assert.equal(resolveApiProxy({ RUNTIME_CONFIG_PATH: cfg }), "http://127.0.0.1:18333");
  const parsed = readRuntimeConfig(cfg);
  assert.equal(parsed?.backendPort, 18333);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveApiProxy falls back to 8080 dev default", () => {
  assert.equal(resolveApiProxy({}), DEV_DEFAULT_API);
});
