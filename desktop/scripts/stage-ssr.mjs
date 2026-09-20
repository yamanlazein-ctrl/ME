#!/usr/bin/env node
/**
 * stage-ssr.mjs — copy checked-in SSR launcher into packaged resources.
 *
 * Source of truth: desktop/ssr/{serve,resolve-api-proxy}.mjs (in git)
 * Target:          desktop/src-tauri/resources/ssr/
 *
 * Also verifies ssr/dist/server/server.js exists (produced by build-frontend.cmd
 * robocopy of dist/ → resources/ssr/dist/). Fails loud if missing so the
 * release gate cannot silently ship without a bootable SSR tree.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SSR_SRC = join(HERE, "..", "ssr");
const DEST_DIR = join(HERE, "..", "src-tauri", "resources", "ssr");
const HANDLER = join(DEST_DIR, "dist", "server", "server.js");
const FILES = ["serve.mjs", "resolve-api-proxy.mjs"];

function fail(msg) {
  console.error(`[stage-ssr] ${msg}`);
  process.exit(1);
}

mkdirSync(DEST_DIR, { recursive: true });
for (const name of FILES) {
  const src = join(SSR_SRC, name);
  const dest = join(DEST_DIR, name);
  if (!existsSync(src) || statSync(src).size <= 0) {
    fail(`source missing or empty: ${src}`);
  }
  copyFileSync(src, dest);
  console.log(`[stage-ssr] copied ${src} -> ${dest}`);
}

const MANIFEST_SRC = join(HERE, "resource-manifest.json");
const MANIFEST_DEST = join(DEST_DIR, "..", "resource-manifest.json");
if (existsSync(MANIFEST_SRC)) {
  copyFileSync(MANIFEST_SRC, MANIFEST_DEST);
  console.log(`[stage-ssr] copied ${MANIFEST_SRC} -> ${MANIFEST_DEST}`);
}

if (!existsSync(HANDLER) || statSync(HANDLER).size <= 0) {
  fail(
    `ssr handler missing: ${HANDLER}\n` +
      "  Run build-frontend.cmd first (pnpm build → robocopy dist → resources/ssr/dist).",
  );
}
console.log(`[stage-ssr] handler present: ${HANDLER} (${statSync(HANDLER).size} bytes)`);
