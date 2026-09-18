#!/usr/bin/env node
/**
 * sync-ssr-deps.mjs — exact-version SSR dependency mirror (packaging parity).
 *
 * Root cause this closes (FIX-PLAN §3.1 lesson, live TypeError
 * "matchedRoutes is not iterable"): TanStack Start INLINES some of its own
 * packages into dist/server/assets/*.js at build time (e.g.
 * @tanstack/start-server-core) while leaving tightly-coupled siblings as
 * BARE runtime imports (e.g. @tanstack/router-core) resolved from
 * resources/node_modules. Rebuilding that folder with caret ranges installed
 * a NEWER router-core whose getMatchedRoutes() return shape no longer matched
 * the inlined caller — a runtime-only crash invisible to every build step.
 *
 * Rule (structural, not advisory): resources/node_modules is NEVER produced
 * by `npm install`. It is a verbatim copy of the EXACT resolved packages
 * from the root node_modules that built dist/ — same bytes, same versions.
 * Any version skew is impossible by construction.
 *
 * Two passes:
 *   1. Scan dist/server for bare `from "X"` / `import "X"` specifiers, union
 *      with the ALWAYS_EXTERNAL floor below (guards against scan blind spots
 *      such as dynamic requires), then close TRANSITIVELY over each
 *      package's own `dependencies` + `optionalDependencies` as resolved in
 *      the root tree (react-dom needs scheduler, recharts needs d3-*, ...).
 *      devDependencies are never copied.
 *   2. Copy every package in the closed set verbatim; write
 *      .sync-manifest.json {pkg: version} for audit.
 *
 * Any scanned external that cannot be resolved in the root node_modules
 * FAILS the build loudly — no silent fallbacks, no partial mirrors.
 *
 * Usage (from before-build.cmd, AFTER the frontend build so dist/ exists):
 *   node "..\scripts\sync-ssr-deps.mjs"
 */
import { readdirSync, readFileSync, existsSync, rmSync, cpSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIST_SERVER = join(ROOT, "dist", "server");
const SRC_NM = join(ROOT, "node_modules");
const DST_NM = join(ROOT, "desktop", "src-tauri", "resources", "node_modules");

// Floor: packages proven external in the TanStack Start SSR bundle across
// builds (FIX-PLAN §3.1 table + later scans). The dist scan below can only
// ADD to this set, never remove — a package dropped from the scan stays
// mirrored rather than risk a dynamic-require miss at customer runtime.
const ALWAYS_EXTERNAL = [
  "@tanstack/history",
  "@tanstack/react-query",
  "@tanstack/query-core",
  "@tanstack/react-router",
  "@tanstack/router-core",
  "@tanstack/react-store",
  "isbot",
  "seroval",
  "seroval-plugins",
  "sonner",
  "cookie-es",
];

function fail(msg) {
  console.error(`[sync-ssr-deps] ERROR: ${msg}`);
  process.exit(1);
}

function topLevel(spec) {
  // "@scope/name/..." -> "@scope/name"; "name/..." -> "name"
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function scanDist(dir, out) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      scanDist(p, out);
      continue;
    }
    if (!p.endsWith(".js")) continue;
    const text = readFileSync(p, "utf8");
    // Bundle emits `from "X"` and `import "X"` (with a space).
    for (const m of text.matchAll(/(?:from|import)\s+"([^"./][^"]*)"/g)) {
      const spec = m[1];
      if (spec.startsWith("node:")) continue;
      out.add(topLevel(spec));
    }
  }
  return out;
}

function readPkg(name) {
  const pj = join(SRC_NM, name, "package.json");
  if (!existsSync(pj)) return null;
  return JSON.parse(readFileSync(pj, "utf8"));
}

if (!existsSync(DIST_SERVER)) {
  fail(`dist/server not found — run the frontend build first (build-frontend.cmd).`);
}

const seeds = new Set([...ALWAYS_EXTERNAL, ...scanDist(DIST_SERVER, new Set())]);

// Transitive closure over runtime deps, as resolved in the root tree.
const closed = new Set();
const queue = [...seeds];
while (queue.length > 0) {
  const name = queue.pop();
  if (closed.has(name)) continue;
  const manifest = readPkg(name);
  if (!manifest) {
    fail(
      `package "${name}" is imported by dist/server but missing from root node_modules. ` +
        `Install it at the root first — refusing to ship an unverified runtime dep.`,
    );
  }
  closed.add(name);
  const runtimeDeps = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const dep of Object.keys(runtimeDeps)) {
    if (!closed.has(dep)) queue.push(dep);
  }
}

const versions = {};
for (const name of [...closed].sort()) {
  const src = join(SRC_NM, name);
  const version = readPkg(name).version;
  const dst = join(DST_NM, name);
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  versions[name] = version;
}

writeFileSync(join(DST_NM, ".sync-manifest.json"), `${JSON.stringify(versions, null, 2)}\n`, "utf8");
console.log(`[sync-ssr-deps] OK: ${closed.size} packages mirrored (seeds: ${seeds.size}), manifest written.`);
