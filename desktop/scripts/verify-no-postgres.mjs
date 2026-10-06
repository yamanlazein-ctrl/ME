#!/usr/bin/env node
/**
 * verify-no-postgres.mjs — SC-002 / AC-2 gate (specs/001-desktop-sqlite-engine T066, quickstart §8).
 *
 *   node desktop/scripts/verify-no-postgres.mjs <dir>            unpacked app / resources tree
 *   node desktop/scripts/verify-no-postgres.mjs <setup.exe>      installer (best effort, see below)
 *   node desktop/scripts/verify-no-postgres.mjs --pid <pid>      a RUNNING instance (its process tree)
 *
 * Fails (exit 1) when:
 *   - files: any postgres.exe, pg_ctl.exe, initdb.exe, pg_dump.exe, pg_restore.exe, psql.exe,
 *     libpq*.dll, db-port.txt, or a pgdata-template\ / postgres\ / pgdata\ directory is present;
 *   - installer: the uncompressed parts of the file name any of those (NSIS LZMA-solid compresses
 *     its file list, so the authoritative check is on the unpacked tree the installer is built from,
 *     `desktop/src-tauri/resources` + `target/release`, which before-build.cmd also runs);
 *   - running: any process in the tree is a PostgreSQL binary, or any process in the tree LISTENS on a
 *     TCP port (the desktop serves on a named pipe only).
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const FORBIDDEN_FILE = /^(postgres\.exe|pg_ctl\.exe|initdb\.exe|pg_dump\.exe|pg_restore\.exe|psql\.exe|libpq.*\.dll|db-port\.txt)$/i;
const FORBIDDEN_DIR = /^(pgdata-template|postgres|pgdata)$/i;

export function scanTree(root) {
  const found = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (FORBIDDEN_DIR.test(e.name)) found.push(`${r}/`);
        else walk(join(dir, e.name), r);
      } else if (FORBIDDEN_FILE.test(e.name)) {
        found.push(r);
      }
    }
  };
  walk(root, "");
  return found;
}

export function scanInstaller(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString("latin1");
  const utf16 = bytes.toString("utf16le");
  const needles = ["postgres.exe", "pg_ctl.exe", "initdb.exe", "pg_dump.exe", "pgdata-template", "libpq.dll", "db-port.txt"];
  return needles.filter((n) => text.toLowerCase().includes(n) || utf16.toLowerCase().includes(n));
}

function ps(command) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`powershell failed: ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout;
}

export function scanRunning(pid) {
  const rows = JSON.parse(ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress") || "[]");
  const byParent = new Map();
  for (const p of rows) {
    if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, []);
    byParent.get(p.ParentProcessId).push(p);
  }
  const root = rows.find((p) => p.ProcessId === pid);
  if (!root) throw new Error(`no process ${pid}`);
  const tree = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    tree.push(p);
    queue.push(...(byParent.get(p.ProcessId) ?? []));
  }
  const problems = [];
  for (const p of tree) {
    if (/^(postgres|pg_ctl|initdb)\.exe$/i.test(p.Name ?? "")) problems.push(`process ${p.ProcessId} is ${p.Name}`);
  }
  // also any postgres.exe started from this app's install folder (it would not be our child after a crash)
  const installDir = root.ExecutablePath ? root.ExecutablePath.replace(/\\[^\\]+$/, "").toLowerCase() : null;
  for (const p of rows) {
    if (/^postgres\.exe$/i.test(p.Name ?? "") && installDir && (p.ExecutablePath ?? "").toLowerCase().startsWith(installDir)) {
      problems.push(`postgres.exe ${p.ProcessId} runs from the app folder`);
    }
  }
  const ids = tree.map((p) => p.ProcessId).join(",");
  const listen = ps(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${ids}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`).trim();
  if (listen) {
    const l = JSON.parse(listen);
    for (const c of Array.isArray(l) ? l : [l]) problems.push(`process ${c.OwningProcess} LISTENS on ${c.LocalAddress}:${c.LocalPort}`);
  }
  return { tree: tree.map((p) => `${p.ProcessId} ${p.Name}`), problems };
}

const isMain = process.argv[1] && basename(process.argv[1]) === "verify-no-postgres.mjs";
if (isMain) {
  const args = process.argv.slice(2);
  let problems = [];
  let what = "";
  if (args[0] === "--pid") {
    const pid = Number(args[1]);
    const r = scanRunning(pid);
    what = `running instance pid ${pid} (tree: ${r.tree.join("; ")})`;
    problems = r.problems;
  } else if (args[0] && existsSync(args[0]) && statSync(args[0]).isDirectory()) {
    what = `tree ${args[0]}`;
    problems = scanTree(args[0]).map((p) => `present: ${p}`);
  } else if (args[0] && existsSync(args[0])) {
    what = `installer ${args[0]} (uncompressed parts only)`;
    problems = scanInstaller(args[0]).map((n) => `names ${n}`);
  } else {
    console.error("usage: verify-no-postgres.mjs <dir> | <setup.exe> | --pid <pid>");
    process.exit(2);
  }
  if (problems.length) {
    console.error(`[verify-no-postgres] FAIL — ${what}`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[verify-no-postgres] PASS — ${what}: no PostgreSQL binary, template, client library, port file or listening port`);
}
