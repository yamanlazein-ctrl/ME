#!/usr/bin/env node
/**
 * stage-node-runtime.mjs — ensure resources/node.exe for packaged desktop (DFP-001).
 *
 * Order:
 *   1. If resources/node.exe already exists and runs `node --version` → keep it.
 *   2. Else if ME_NODE_EXE points at an existing node.exe → copy it.
 *   3. Else download the pinned official Node win-x64 zip and extract node.exe.
 *
 * Pin is intentional: packaging must be reproducible, not "whatever is on PATH".
 */
import { createWriteStream, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "src-tauri", "resources");
const DEST = join(RES, "node.exe");
const CACHE = join(HERE, "..", ".cache", "node-runtime");

/** Official Node.js LTS win-x64 — bump deliberately when updating the pin. */
const NODE_VERSION = process.env.ME_NODE_VERSION || "22.14.0";
const ZIP_NAME = `node-v${NODE_VERSION}-win-x64.zip`;
const ZIP_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${ZIP_NAME}`;

function fail(msg) {
  console.error(`[stage-node-runtime] ${msg}`);
  process.exit(1);
}

function nodeWorks(exe) {
  if (!existsSync(exe)) return false;
  const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 && /^v\d+/.test(String(r.stdout || "").trim());
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`download failed ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extractNodeExe(zipPath, outExe) {
  // Prefer PowerShell Expand-Archive to a temp dir, then copy node.exe
  const tmp = join(CACHE, `extract-${NODE_VERSION}`);
  mkdirSync(tmp, { recursive: true });
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (ps.status !== 0) {
    fail(`Expand-Archive failed: ${ps.stderr || ps.stdout || "unknown"}`);
  }
  const nested = join(tmp, `node-v${NODE_VERSION}-win-x64`, "node.exe");
  if (!existsSync(nested)) fail(`zip did not contain node.exe at ${nested}`);
  mkdirSync(dirname(outExe), { recursive: true });
  copyFileSync(nested, outExe);
}

async function main() {
  mkdirSync(RES, { recursive: true });

  if (nodeWorks(DEST)) {
    console.log(`[stage-node-runtime] OK: existing ${DEST}`);
    return;
  }

  const envExe = process.env.ME_NODE_EXE;
  if (envExe && nodeWorks(envExe)) {
    copyFileSync(envExe, DEST);
    if (!nodeWorks(DEST)) fail(`copied ME_NODE_EXE but dest does not run: ${DEST}`);
    console.log(`[stage-node-runtime] staged from ME_NODE_EXE -> ${DEST}`);
    return;
  }

  const zipPath = join(CACHE, ZIP_NAME);
  if (!existsSync(zipPath)) {
    console.log(`[stage-node-runtime] downloading ${ZIP_URL}`);
    await download(ZIP_URL, zipPath);
  } else {
    console.log(`[stage-node-runtime] using cached zip ${zipPath}`);
  }

  extractNodeExe(zipPath, DEST);
  if (!nodeWorks(DEST)) fail(`staged node.exe does not run: ${DEST}`);
  console.log(`[stage-node-runtime] staged ${DEST} (Node ${NODE_VERSION})`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
