#!/usr/bin/env node
/**
 * stage-backend.mjs — backend packaging staging (packaging parity).
 *
 * Root cause this closes: NOTHING populated resources/backend or
 * resources/node.exe — no script, no docs. The last MSI was staged by hand,
 * so a fresh `tauri build` either fails (missing inputs — loud, tolerable)
 * or, worse, succeeds with a STALE backend nobody rebuilt (silent, ships
 * old business logic to customers).
 *
 * Rule: every packaging run rebuilds the backend from source and mirrors
 * the exact runtime tree. Stale reuse is impossible by construction.
 *
 * Steps:
 *   1. Require resources/node.exe to exist (portable Node runtime, staged by
 *      stage-node-runtime.mjs in before-build.cmd). FAIL loudly if absent;
 *      never substitute silently with PATH node.
 *   2. `npm run build` in backend/ (tsc). Any type error fails packaging.
 *   3. Mirror into resources/backend: dist/, package.json, backend
 *      node_modules (runtime deps server.js resolves from backend_dir), and
 *      src/infrastructure/orm/migrations (DESKTOP_MIGRATIONS_FOLDER points
 *      at source-tree migrations at runtime).
 *   4. Write .stage-manifest.json {builtAt, nodeVersion, backendVersion}.
 *
 * Usage (from before-build.cmd, after the frontend build):
 *   node "..\scripts\stage-backend.mjs"
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BACKEND = join(ROOT, "backend");
const RES = join(ROOT, "desktop", "src-tauri", "resources");
const DST_BACKEND = join(RES, "backend");

function fail(msg) {
  console.error(`[stage-backend] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

// 1. Node runtime must be staged explicitly by release engineering.
const nodeExe = join(RES, "node.exe");
if (!existsSync(nodeExe)) {
  fail(
    `resources/node.exe is missing. Place the portable Node LTS runtime's node.exe here ` +
      `(it ships inside the installer and runs the backend + SSR on customer machines with no Node.js installed).`,
  );
}
try {
  const v = execSync(`"${nodeExe}" --version`, { encoding: "utf8" }).trim();
  console.log(`[stage-backend] staged node runtime: ${v}`);
} catch {
  fail(`resources/node.exe exists but does not execute (--version failed). Replace it.`);
}

// 2. Rebuild backend from source — stale dist/ can never ship.
console.log("[stage-backend] rebuilding backend (npm run build)...");
try {
  run("npm run build", BACKEND);
} catch {
  fail("backend build failed — fix type errors before packaging.");
}

// 3. Mirror the runtime tree.
const serverJs = join(BACKEND, "dist", "backend", "src", "presentation", "server.js");
if (!existsSync(serverJs)) fail(`expected server entry missing after build: ${serverJs}`);
const migrations = join(BACKEND, "src", "infrastructure", "orm", "migrations");
if (!existsSync(migrations)) fail(`migrations folder missing: ${migrations}`);
const backendNm = join(BACKEND, "node_modules");
if (!existsSync(backendNm)) fail(`backend/node_modules missing — run 'npm install' in backend/ first.`);

rmSync(DST_BACKEND, { recursive: true, force: true });
cpSync(join(BACKEND, "dist"), join(DST_BACKEND, "dist"), { recursive: true });
cpSync(join(BACKEND, "package.json"), join(DST_BACKEND, "package.json"));
cpSync(backendNm, join(DST_BACKEND, "node_modules"), { recursive: true });
cpSync(migrations, join(DST_BACKEND, "src", "infrastructure", "orm", "migrations"), {
  recursive: true,
});

// 4. Manifest for audit.
const backendPkg = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8"));
const manifest = {
  builtAt: new Date().toISOString(),
  backendVersion: backendPkg.version ?? "unknown",
  serverEntry: "dist/backend/src/presentation/server.js",
};
writeFileSync(join(DST_BACKEND, ".stage-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[stage-backend] OK: backend ${manifest.backendVersion} staged (${manifest.builtAt}).`);
