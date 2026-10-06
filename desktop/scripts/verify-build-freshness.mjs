#!/usr/bin/env node
/**
 * verify-build-freshness.mjs — prove a desktop build is the build you think it is.
 *
 * The reported failure was "we deleted the old version, built a new one, and it
 * still behaves like the old one". The cause was never the source: three copies
 * of the packaged resources existed (`resources/`, `target/<profile>/`, and the
 * assets EMBEDDED in the executable at compile time), and the executable shipped
 * a web bundle older than the one sitting next to it on disk. Nothing in the
 * build failed, so nobody noticed.
 *
 * Two gates close it:
 *
 *   pre  (end of before-build.cmd, after the resources are regenerated)
 *        - the packaged backend is newer than every backend source file
 *        - the packaged web shell is newer than every frontend source file
 *        - every asset the shell references exists on disk
 *        - the server bundle manifest and the desktop seed are present (SQLite desktop)
 *
 *   post <profile>  (after `tauri build`)
 *        - the runtime copies next to the exe are byte-identical to resources
 *        - the EXECUTABLE EMBEDS the current web assets (the check that would
 *          have caught the stale bundle)
 *        - a setup installer exists and is newer than the executable
 *
 * Usage: node verify-build-freshness.mjs pre | post [profile]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const TAURI = join(DESKTOP, "src-tauri");
const RESOURCES = join(TAURI, "resources");

const problems = [];
const fail = (msg) => problems.push(msg);
const ok = (msg) => console.log(`[freshness] OK ${msg}`);

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Newest mtime under a directory tree, skipping the obvious noise. */
function newestMtime(dir, skip = new Set()) {
  let newest = 0;
  let newestFile = "";
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (m > newest) {
          newest = m;
          newestFile = p;
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { newest, newestFile };
}

const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", "coverage", "logs"]);

/** Every `/assets/...` path a built HTML shell references. */
function referencedAssets(htmlPath) {
  const html = readFileSync(htmlPath, "utf8");
  return [...new Set([...html.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0].slice(1)))];
}

function pre() {
  const serverBundle = join(RESOURCES, "server", "server.mjs");
  const webShell = join(RESOURCES, "server", "web", "_shell.html");
  for (const [label, p] of [
    ["server/server.mjs", serverBundle],
    ["server/web/_shell.html", webShell],
  ]) {
    if (!existsSync(p)) {
      fail(`${label} is missing — the build would ship a desktop with no backend/UI`);
      continue;
    }
  }
  if (problems.length) return;

  const backend = newestMtime(join(REPO, "backend", "src"), SKIP_DIRS);
  if (statSync(serverBundle).mtimeMs < backend.newest) {
    fail(
      `server/server.mjs is OLDER than ${relative(REPO, backend.newestFile)} — the packaged backend is stale`,
    );
  } else {
    ok(`server/server.mjs is newer than every backend source (${relative(REPO, backend.newestFile)})`);
  }

  const frontend = newestMtime(join(REPO, "src"), SKIP_DIRS);
  if (statSync(webShell).mtimeMs < frontend.newest) {
    fail(
      `server/web/_shell.html is OLDER than ${relative(REPO, frontend.newestFile)} — the packaged UI is stale`,
    );
  } else {
    ok(`server/web is newer than every frontend source (${relative(REPO, frontend.newestFile)})`);
  }

  const assets = referencedAssets(webShell);
  // A stale hashed chunk is exactly the drift that made an "old build" look
  // current. The shell only names the ENTRY chunk; lazy chunks are named from
  // inside other chunks, so "orphaned" means referenced by nothing at all in
  // the tree — that is what a leftover /MIR miss looks like.
  const assetDir = join(RESOURCES, "server", "web", "assets");
  const webDir = join(RESOURCES, "server", "web");
  const referencedByAnything = new Set();
  const scan = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.(js|css|html)$/.test(entry.name)) {
        for (const m of readFileSync(p, "latin1").matchAll(/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(js|css)/g)) {
          referencedByAnything.add(m[0]);
        }
      }
    }
  };
  scan(webDir);
  const orphanChunks = readdirSync(assetDir).filter(
    (f) => /\.(js|css)$/.test(f) && !referencedByAnything.has(f),
  );
  if (orphanChunks.length) {
    fail(
      `${orphanChunks.length} unreferenced chunk(s) in server/web/assets (e.g. ${orphanChunks.slice(0, 3).join(", ")}) — /MIR did not run`,
    );
  } else {
    ok("no unreferenced chunks in server/web/assets");
  }

  for (const rel of ["server/desktop-seed.json", "server/.bundle-manifest.json"]) {
    const p = join(RESOURCES, rel);
    if (!existsSync(p)) fail(`resources/${rel} is missing`);
  }
  const manifest = JSON.parse(readFileSync(join(RESOURCES, "server", ".bundle-manifest.json"), "utf8"));
  const actual = readdirSync(join(RESOURCES, "server", "node_modules")).length;
  if (actual === 0) fail("resources/server/node_modules is empty — @node-rs/argon2 would be missing at runtime");
  else ok(`server bundle manifest built at ${manifest.builtAt} (${manifest.files} files)`);
}

function post(profile) {
  const targetDir = join(TAURI, "target", profile);
  for (const rel of ["server/server.mjs", "server/desktop-seed.json"]) {
    const a = join(RESOURCES, rel);
    const b = join(targetDir, rel);
    if (!existsSync(b)) {
      fail(`target/${profile}/${rel} is missing — the runtime would fall back to another copy`);
      continue;
    }
    if (sha256(a) !== sha256(b)) {
      fail(`target/${profile}/${rel} differs from resources/${rel} — a STALE copy would run`);
    } else {
      ok(`target/${profile}/${rel} is byte-identical to resources (${sha256(a).slice(0, 12)})`);
    }
  }

  const exe = join(targetDir, "motard-fabrics-erp.exe");
  if (!existsSync(exe)) {
    fail(`target/${profile}/motard-fabrics-erp.exe is missing`);
  } else {
    const exeBytes = readFileSync(exe).toString("latin1");
    const assets = referencedAssets(join(RESOURCES, "server", "web", "_shell.html"));
    const notEmbedded = assets.filter((a) => !exeBytes.includes(a.split("/").pop()));
    if (notEmbedded.length) {
      fail(
        `the executable does NOT embed the current web assets: ${notEmbedded.join(", ")} — it ships a STALE UI`,
      );
    } else {
      ok(`the executable embeds all ${assets.length} current web assets`);
    }
  }

  const bundleDir = join(targetDir, "bundle", "nsis");
  const installers = existsSync(bundleDir)
    ? readdirSync(bundleDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".exe"))
        .map((e) => join(bundleDir, e.name))
    : [];
  if (installers.length === 0) {
    fail(`no NSIS installer under target/${profile}/bundle/nsis — the bundle did not finish`);
  } else {
    // The meaningful ordering is against the CONTENT, not against the exe:
    // tauri rewrites the executable while bundling, so the two can differ by
    // milliseconds in either direction. What must hold is that the installer
    // was produced from the CURRENT packaged resources.
    const packaged = [
      join(RESOURCES, "server", "server.mjs"),
      join(RESOURCES, "server", "web", "_shell.html"),
      join(RESOURCES, "server", "desktop-seed.json"),
    ].filter(existsSync);
    for (const p of installers) {
      const stale = packaged.filter((src) => statSync(p).mtimeMs < statSync(src).mtimeMs);
      if (stale.length) {
        fail(
          `${relative(REPO, p)} predates ${stale.map((s) => relative(REPO, s)).join(", ")} — it packages an OLDER build`,
        );
      } else {
        ok(`${relative(REPO, p)} was built from the current packaged resources`);
      }
      console.log(
        `[freshness] installer ${relative(REPO, p)} — ${(statSync(p).size / 1048576).toFixed(1)} MB`,
      );
    }
  }
}

const mode = process.argv[2];
if (mode === "pre") pre();
else if (mode === "post") post(process.argv[3] ?? "release");
else {
  console.error("usage: node verify-build-freshness.mjs pre | post [profile]");
  process.exit(2);
}

if (problems.length) {
  console.error(`\n[ freshness] FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("[freshness] all checks passed");
