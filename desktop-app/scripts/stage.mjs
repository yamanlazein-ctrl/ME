#!/usr/bin/env node
/**
 * Stage everything `tauri build` packages (ADR-001), from the repo's own sources:
 *
 *   build/web/                     the ERP UI (static SPA) + the shell's boot page
 *   build/resources/runtime/       node.exe (pinned, sha256-checked against nodejs.org)
 *   build/resources/server/        backend bundle, native addons, SQLite migrations, first-run seed
 *   build/resources/license-public.pem
 *
 * The licence PRIVATE key is read from the environment or backend/.env, used for the seed only, and
 * the script fails if any staged file contains private key material or a .env file.
 *
 *   node scripts/stage.mjs            (from desktop-app/)
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(APP, "..");
const BACKEND = join(ROOT, "backend");
const NM = join(BACKEND, "node_modules");
const OUT = join(APP, "build");
const RES = join(OUT, "resources");
const SERVER = join(RES, "server");
const NODE_VERSION = "22.14.0";
const appVersion = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")).version;

const log = (m) => console.log(`[stage] ${m}`);
const fail = (m) => {
  console.error(`[stage] ERROR: ${m}`);
  process.exit(1);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
for (const file of [
  join(ROOT, "package.json"),
  join(BACKEND, "package.json"),
  join(APP, "src-tauri", "tauri.conf.json"),
]) {
  if (JSON.parse(readFileSync(file, "utf8")).version !== appVersion)
    fail(`release version mismatch in ${file}`);
}
const cargoVersion = readFileSync(join(APP, "src-tauri", "Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (cargoVersion !== appVersion) fail("Cargo.toml release version mismatch");
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });

// ── identity: one tenant id for every release of this customer's build ──────────────────────────
// The frontend's default tenant and the seed's tenant must stay the same across updates, or a newer
// build would look for a company the customer's database does not have.
const identityFile = join(APP, "release-identity.json");
if (!existsSync(identityFile)) {
  writeFileSync(identityFile, `${JSON.stringify({ tenantId: randomUUID() }, null, 2)}\n`);
  log(`new release identity written to ${identityFile} (commit it)`);
}
const { tenantId } = JSON.parse(readFileSync(identityFile, "utf8"));
if (!/^[0-9a-f-]{36}$/.test(tenantId)) fail("release-identity.json tenantId is not a UUID");

// ── signing keys (never printed) ────────────────────────────────────────────────────────────────
const dotenv = createRequire(join(BACKEND, "package.json"))("dotenv");
const fileEnv = existsSync(join(BACKEND, ".env"))
  ? dotenv.parse(readFileSync(join(BACKEND, ".env")))
  : {};
const privKey = (process.env.LICENSE_SIGNING_KEY || fileEnv.LICENSE_SIGNING_KEY || "").trim();
const pubKey = (
  process.env.LICENSE_SIGNING_PUBLIC_KEY ||
  fileEnv.LICENSE_SIGNING_PUBLIC_KEY ||
  ""
).trim();
if (!privKey || !pubKey)
  fail("LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY not set (env or backend/.env)");
const shippedPem = readFileSync(
  join(APP, "src-tauri", "resources", "license-public.pem"),
  "utf8",
).trim();
if (shippedPem.replace(/\s+/g, "") !== pubKey.replace(/\s+/g, ""))
  fail("src-tauri/resources/license-public.pem does not match LICENSE_SIGNING_PUBLIC_KEY");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });

// ── 1. frontend ─────────────────────────────────────────────────────────────────────────────────
log("building the UI (desktop SPA)");
rmSync(join(ROOT, "dist"), { recursive: true, force: true });
run("npm", ["run", "build"], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_DESKTOP_DEPLOY: "true",
    VITE_APP_VERSION: appVersion,
    VITE_API_BASE_URL: "",
    VITE_DEFAULT_TENANT_ID: tenantId,
  },
});
const client = join(ROOT, "dist", "client");
if (!existsSync(join(client, "_shell.html")))
  fail("dist/client/_shell.html missing (SPA prerender)");
cpSync(client, join(OUT, "web"), { recursive: true });
cpSync(join(client, "_shell.html"), join(OUT, "web", "index.html"));
for (const f of readdirSync(join(APP, "src-tauri", "pages")))
  cpSync(join(APP, "src-tauri", "pages", f), join(OUT, "web", f));

// ── 2. backend bundle ───────────────────────────────────────────────────────────────────────────
log("bundling the backend");
const banner = `// Motard ERP desktop release ${appVersion}
import { createRequire as __cr } from "node:module";
import { fileURLToPath as __fu } from "node:url";
import { dirname as __dn, join as __jn } from "node:path";
const require = __cr(import.meta.url);
const __filename = __fu(import.meta.url);
const __dirname = __dn(__filename);
globalThis.__bundlerPathsOverrides = {
  "pino-worker": __jn(__dirname, "pino-worker.cjs"),
  "thread-stream-worker": __jn(__dirname, "thread-stream-worker.cjs"),
};`;
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
};
await build({
  ...common,
  entryPoints: [join(BACKEND, "src", "presentation", "server.ts")],
  outfile: join(SERVER, "server.mjs"),
  format: "esm",
  tsconfig: join(BACKEND, "tsconfig.json"),
  banner: { js: banner },
  external: [
    "@node-rs/argon2",
    "better-sqlite3",
    "pg-native",
    "@sentry/profiling-node",
    "pino-pretty",
  ],
});
await build({
  ...common,
  entryPoints: [join(NM, "pino", "lib", "worker.js")],
  outfile: join(SERVER, "pino-worker.cjs"),
  format: "cjs",
});
await build({
  ...common,
  entryPoints: [join(NM, "thread-stream", "lib", "worker.js")],
  outfile: join(SERVER, "thread-stream-worker.cjs"),
  format: "cjs",
});
await build({
  ...common,
  entryPoints: [join(NM, "pino-roll", "pino-roll.js")],
  outfile: join(SERVER, "node_modules", "pino-roll", "index.cjs"),
  format: "cjs",
});
writeFileSync(
  join(SERVER, "node_modules", "pino-roll", "package.json"),
  JSON.stringify({ name: "pino-roll", main: "index.cjs" }),
);
for (const pkg of ["@node-rs/argon2", "@node-rs/argon2-win32-x64-msvc", "@node-rs/helper"]) {
  if (existsSync(join(NM, pkg)))
    cpSync(join(NM, pkg), join(SERVER, "node_modules", pkg), { recursive: true });
  else if (pkg !== "@node-rs/helper") fail(`missing ${pkg} in backend/node_modules`);
}
{
  const src = join(NM, "better-sqlite3");
  const dst = join(SERVER, "node_modules", "better-sqlite3");
  if (!existsSync(join(src, "prebuilds", "win32-x64.node")))
    fail("missing better-sqlite3 win32-x64 prebuild");
  mkdirSync(join(dst, "prebuilds"), { recursive: true });
  cpSync(join(src, "package.json"), join(dst, "package.json"));
  cpSync(join(src, "lib"), join(dst, "lib"), { recursive: true });
  cpSync(join(src, "prebuilds", "win32-x64.node"), join(dst, "prebuilds", "win32-x64.node"));
}
cpSync(
  join(BACKEND, "src", "infrastructure", "orm", "sqlite", "migrations"),
  join(SERVER, "sqlite-migrations"),
  { recursive: true },
);

// ── 3. first-run seed (default tenant + signed licence; no users, no business data) ─────────────
log("building the first-run seed");
const seedPath = join(SERVER, "desktop-seed.json");
run("npx", ["tsx", "src/scripts/build-desktop-seed.ts", "--out", seedPath], {
  cwd: BACKEND,
  env: {
    ...process.env,
    SEED_TENANT_ID: tenantId,
    LICENSE_SIGNING_KEY: privKey,
    LICENSE_SIGNING_PUBLIC_KEY: pubKey,
    DB_ENGINE: "sqlite",
    // Only satisfies the backend config schema; the builder uses its own scratch database.
    SQLITE_PATH: join(tmpdir(), `motard-seed-config-${process.pid}.db`),
  },
});
{
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const keys = Object.keys(seed).sort().join(",");
  if (seed.format !== "motard-desktop-seed" || seed.version !== 1)
    fail("seed: wrong format/version");
  if (keys !== "builtAt,format,license,tenant,version") fail(`seed: unexpected sections ${keys}`);
  if (seed.tenant?.id !== tenantId || seed.license?.tenant_id !== tenantId)
    fail("seed: tenant/licence mismatch");
  if (!seed.license?.offline_token) fail("seed: licence has no signed offline token");
  if ("devPublicJwk" in seed) fail("seed: dev-ephemeral key present");
}

// ── 4. Node runtime ─────────────────────────────────────────────────────────────────────────────
log(`staging node ${NODE_VERSION}`);
const cache = join(APP, ".cache");
mkdirSync(cache, { recursive: true });
const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
const zipPath = join(cache, zipName);
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const expected = sums
  .split("\n")
  .find((l) => l.endsWith(`  ${zipName}`))
  ?.split(" ")[0];
if (!expected) fail("node SHASUMS256.txt has no entry for the zip");
if (!existsSync(zipPath) || sha256(readFileSync(zipPath)) !== expected) {
  const res = await fetch(`${base}/${zipName}`);
  if (!res.ok) fail(`node download failed (${res.status})`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
}
if (sha256(readFileSync(zipPath)) !== expected) fail("node zip sha256 mismatch");
const extract = join(cache, `node-${NODE_VERSION}`);
if (!existsSync(join(extract, `node-v${NODE_VERSION}-win-x64`, "node.exe"))) {
  mkdirSync(extract, { recursive: true });
  // Windows' bsdtar reads zip; Git's GNU tar (often first on PATH) takes "C:" for a remote host.
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-xf", zipPath, "-C", extract, `node-v${NODE_VERSION}-win-x64/node.exe`], {
    stdio: "inherit",
  });
}
mkdirSync(join(RES, "runtime"), { recursive: true });
cpSync(
  join(extract, `node-v${NODE_VERSION}-win-x64`, "node.exe"),
  join(RES, "runtime", "node.exe"),
);
cpSync(join(APP, "src-tauri", "resources", "license-public.pem"), join(RES, "license-public.pem"));

// ── 5. gates ────────────────────────────────────────────────────────────────────────────────────
log("checking the staged files");
const walk = (d) =>
  readdirSync(d).flatMap((n) =>
    statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
  );
const files = walk(OUT);
const privBody = privKey.replace(/-----[^-]+-----|\s|\\n/g, "").slice(0, 40);
for (const f of files) {
  if (/(^|[\\/])\.env(\.|$)/.test(f)) fail(`staged a .env file: ${f}`);
  if (statSync(f).size > 64 * 1024 * 1024 || f.endsWith(".node") || f.endsWith(".exe")) continue;
  const text = readFileSync(f, "latin1");
  if (text.includes("PRIVATE KEY-----") || (privBody && text.includes(privBody)))
    fail(`private key material in ${f}`);
}
for (const must of [
  "web/index.html",
  "web/boot.html",
  "web/boot.js",
  "resources/server/server.mjs",
  "resources/runtime/node.exe",
])
  if (!existsSync(join(OUT, must))) fail(`missing ${must}`);
const manifest = files.map((f) => ({
  path: f.slice(OUT.length + 1).replace(/\\/g, "/"),
  sha256: sha256(readFileSync(f)),
}));
writeFileSync(
  join(OUT, "build-manifest.json"),
  `${JSON.stringify({ appVersion, tenantId, node: NODE_VERSION, files: manifest.length, manifest }, null, 1)}\n`,
);
log(`done: ${files.length} files staged`);
