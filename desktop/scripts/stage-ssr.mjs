#!/usr/bin/env node
/**
 * stage-ssr.mjs — copy checked-in SSR launcher into packaged resources.
 *
 * Source of truth: desktop/ssr/serve.mjs (in git)
 * Target:          desktop/src-tauri/resources/ssr/serve.mjs
 *
 * Also verifies ssr/dist/server/server.js exists (produced by build-frontend.cmd
 * robocopy of dist/ → resources/ssr/dist/). Fails loud if missing so the
 * release gate cannot silently ship without a bootable SSR tree.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(HERE, "..", "ssr", "serve.mjs");
const DEST_DIR = join(HERE, "..", "src-tauri", "resources", "ssr");
const DEST = join(DEST_DIR, "serve.mjs");
const HANDLER = join(DEST_DIR, "dist", "server", "server.js");

function fail(msg) {
  console.error(`[stage-ssr] ${msg}`);
  process.exit(1);
}

if (!existsSync(SRC) || statSync(SRC).size <= 0) {
  fail(`source missing or empty: ${SRC}`);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);
console.log(`[stage-ssr] copied ${SRC} -> ${DEST}`);

if (!existsSync(HANDLER) || statSync(HANDLER).size <= 0) {
  fail(
    `ssr handler missing: ${HANDLER}\n` +
      "  Run build-frontend.cmd first (pnpm build → robocopy dist → resources/ssr/dist).",
  );
}
console.log(`[stage-ssr] handler present: ${HANDLER} (${statSync(HANDLER).size} bytes)`);
