#!/usr/bin/env node
/**
 * bundle-server.mjs — packages the backend for the desktop as a handful of files instead of a node_modules tree.
 *
 * Why: the previous package shipped backend/node_modules (19,179 files) plus the SSR runtime (9,863 files).
 * Windows Installer and Defender handle every file separately, which is what made installation take 10+ minutes
 * and cold starts take minutes (Node opened thousands of small files on the first boot).
 *
 * Output (desktop/src-tauri/resources/server):
 *   server.mjs                     the whole backend (esbuild bundle, ESM)
 *   pino-worker.cjs                pino's log worker      ┐ required because pino loads them by path,
 *   thread-stream-worker.cjs       thread-stream's worker ┘ which a bundle cannot resolve on its own
 *   node_modules/pino-roll/        log-rotation transport, bundled to a single file
 *   node_modules/@node-rs/argon2*  the only native module (prebuilt win32-x64 binary)
 *   migrations/                    drizzle SQL migrations (read at boot)
 *   web/                           the built single-page frontend (copied by stage-web.mjs)
 *
 * Usage: node desktop/scripts/bundle-server.mjs
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const BACKEND = join(ROOT, "backend");
const OUT = join(ROOT, "desktop", "src-tauri", "resources", "server");
const NM = join(BACKEND, "node_modules");

const fail = (m) => {
  console.error(`[bundle-server] ERROR: ${m}`);
  process.exit(1);
};

// Keep the staged web/ dir (built separately); rebuild everything else from scratch so nothing stale ships.
mkdirSync(OUT, { recursive: true });
for (const e of readdirSync(OUT)) if (e !== "web") rmSync(join(OUT, e), { recursive: true, force: true });

const banner = `import { createRequire as __cr } from "node:module";
import { fileURLToPath as __fu } from "node:url";
import { dirname as __dn, join as __jn } from "node:path";
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);
globalThis.__bundlerPathsOverrides = {
  "pino-worker": __jn(__dirname, "pino-worker.cjs"),
  "thread-stream-worker": __jn(__dirname, "thread-stream-worker.cjs"),
};`;

const common = { bundle: true, platform: "node", target: "node22", legalComments: "none", logLevel: "warning", minify: false };

console.log("[bundle-server] bundling backend → server.mjs");
await build({
  ...common,
  entryPoints: [join(BACKEND, "src", "presentation", "server.ts")],
  outfile: join(OUT, "server.mjs"),
  format: "esm",
  tsconfig: join(BACKEND, "tsconfig.json"),
  banner: { js: banner },
  // native addon (loaded from the neighbouring node_modules) + optional/unused drivers
  external: ["@node-rs/argon2", "pg-native", "@sentry/profiling-node", "pino-pretty"],
});

console.log("[bundle-server] bundling pino workers + pino-roll transport");
await build({ ...common, entryPoints: [join(NM, "pino", "lib", "worker.js")], outfile: join(OUT, "pino-worker.cjs"), format: "cjs" });
await build({
  ...common,
  entryPoints: [join(NM, "thread-stream", "lib", "worker.js")],
  outfile: join(OUT, "thread-stream-worker.cjs"),
  format: "cjs",
});
await build({
  ...common,
  entryPoints: [join(NM, "pino-roll", "pino-roll.js")],
  outfile: join(OUT, "node_modules", "pino-roll", "index.cjs"),
  format: "cjs",
});
writeFileSync(join(OUT, "node_modules", "pino-roll", "package.json"), JSON.stringify({ name: "pino-roll", main: "index.cjs" }));

console.log("[bundle-server] copying native argon2 (win32-x64 only)");
for (const pkg of ["@node-rs/argon2", "@node-rs/argon2-win32-x64-msvc"]) {
  const src = join(NM, pkg);
  if (!existsSync(src)) fail(`missing ${pkg} in backend/node_modules`);
  cpSync(src, join(OUT, "node_modules", pkg), { recursive: true });
}
// @node-rs/argon2 also depends on @node-rs/helper at runtime.
const helper = join(NM, "@node-rs", "helper");
if (existsSync(helper)) cpSync(helper, join(OUT, "node_modules", "@node-rs", "helper"), { recursive: true });

console.log("[bundle-server] copying migrations");
cpSync(join(BACKEND, "src", "infrastructure", "orm", "migrations"), join(OUT, "migrations"), { recursive: true });

const count = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
const pkgJson = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8"));
writeFileSync(
  join(OUT, ".bundle-manifest.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), backendVersion: pkgJson.version, node: process.version, files: count(OUT), bytes: size(OUT) }, null, 2) + "\n",
);
console.log(`[bundle-server] OK — ${count(OUT)} files, ${(size(OUT) / 1e6).toFixed(1)} MB (was 19,179 files / 145 MB)`);
