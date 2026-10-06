#!/usr/bin/env node
/**
 * US3 startup-choice flows driven through the REAL desktop window (specs/001-desktop-sqlite-engine T085/T086).
 *
 * Launches the desktop executable with WebView2 remote debugging, reads what the startup screen renders
 * and presses its buttons over the Chrome DevTools Protocol — the same `startup_choose` IPC a user's
 * click sends. Uses an existing data root that has been launched once (FRESH) and is NOT a customer's.
 *
 *   node scripts/lifecycle/startup-choices-e2e.mjs --exe <motard-fabrics-erp.exe> --root <data root> [--out report.json]
 *
 * Flows (contracts/data-root-and-startup-states.md):
 *   1 restart, nothing changed                      → REUSE, no prompt
 *   2 reinstall (new marker GUID) → "Open existing"  → same data_id, motard_meta records the new instance;
 *                                                     the next restart is REUSE with no prompt
 *   3 in-app update hand-off (token names the recorded GUID, toVersion = running) → REUSE, no prompt,
 *                                                     token consumed, new instance recorded
 *   4 reinstall → "Start new"                         → old data kept in set-aside\, a NEW data_id
 *   5 the screen offers exactly the contract options and no corruption wording outside CORRUPT
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const EXE = args.exe;
const ROOT = args.root;
if (!EXE || !ROOT) throw new Error("--exe and --root are required");
const PORT = 9333;
const here = dirname(fileURLToPath(import.meta.url));
const Database = createRequire(join(here, "../../backend/package.json"))("better-sqlite3");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REG = "HKCU\\Software\\MotardFabricsErp";

const reg = {
  get() {
    try {
      const out = execFileSync("reg", ["query", REG, "/v", "InstallInstanceId"], { encoding: "utf8" });
      return out.match(/REG_SZ\s+(\S+)/)?.[1] ?? null;
    } catch { return null; }
  },
  set(v) { execFileSync("reg", ["add", REG, "/v", "InstallInstanceId", "/t", "REG_SZ", "/d", v, "/f"], { stdio: "ignore" }); },
};

function stopApp() {
  // ExecutablePath uses backslashes; a forward-slash prefix would match nothing and leave the app up
  const dir = dirname(EXE).replace(/\//g, "\\").replace(/'/g, "''");
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
}

function meta() {
  const db = new Database(join(ROOT, "data", "motard.db"), { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT data_id, install_instance_id, adopted_installation_ids, created_by_installation_id FROM motard_meta WHERE id = 1").get(); }
  finally { db.close(); }
}

function startupLines() {
  const f = join(ROOT, "logs", "startup.log");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { return []; }
}

async function cdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const evaluate = (expression) => new Promise((res) => {
    const n = ++id;
    pending.set(n, (d) => res(d.result?.result?.value));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

/** Launch; resolve with { prompt } when the startup screen shows, or { ready } when the main window loads. */
async function launch(timeoutMs = 90_000) {
  const before = startupLines().length;
  const child = spawn(EXE, [], {
    detached: true, stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    const lines = startupLines();
    const ts = await targets();
    const recovery = ts.find((t) => t.type === "page" && /recovery\.html/.test(t.url));
    if (lines.length > before && recovery) {
      const c = await cdp(recovery);
      // wait until the page rendered the prompt
      for (let i = 0; i < 30; i++) {
        const shown = await c.evaluate(`document.body.className === "startup" && document.querySelectorAll("#s-options button").length > 0`);
        if (shown) break;
        await sleep(500);
      }
      const screen = await c.evaluate(`({ title: document.getElementById("s-title").textContent,
        why: document.getElementById("why2").textContent,
        buttons: Array.from(document.querySelectorAll("#s-options button")).map(b => b.textContent) })`);
      const prompt = await c.evaluate(`window.__TAURI_INTERNALS__.invoke("startup_status")`);
      return { prompt, screen, c };
    }
    const main = ts.find((t) => t.type === "page" && !/recovery\.html|splash\.html/.test(t.url));
    if (main && lines.length === before) {
      // the main window is up; make sure the API answers through the pipe
      const c = await cdp(main);
      const health = await c.evaluate(`window.__TAURI_INTERNALS__.invoke("api", { req: { method: "GET", path: "/api/health/live" } }).then(r => r.status)`);
      c.close();
      if (health === 200) return { ready: true };
    }
  }
  return { timeout: true };
}

async function waitReady(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    const main = (await targets()).find((t) => t.type === "page" && !/recovery\.html|splash\.html/.test(t.url));
    if (!main) continue;
    const c = await cdp(main);
    const s = await c.evaluate(`window.__TAURI_INTERNALS__.invoke("api", { req: { method: "GET", path: "/api/health/live" } }).then(r => r.status).catch(() => 0)`);
    c.close();
    if (s === 200) return true;
  }
  return false;
}

const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, pass: !!ok, ...detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, Object.keys(detail).length ? JSON.stringify(detail) : ""); };
const CORRUPTION = /تالف|تلف|corrupt/i;

const originalMarker = reg.get();
try {
  stopApp();
  {
    const left = execFileSync("powershell", ["-NoProfile", "-Command",
      `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq '${EXE.replace(/\//g, "\\")}' }).Count`], { encoding: "utf8" }).trim();
    if (left !== "0") throw new Error("the app is still running after stopApp — every launch would reach the old instance");
  }
  // 1 — plain restart. Start consistent: the installed instance is the one the database records
  // (a previous run may have left a "Start new" company with another instance id).
  const recorded = meta().install_instance_id;
  if (recorded) reg.set(recorded);
  let r = await launch();
  check("1 restart with nothing changed is REUSE with no prompt", r.ready, { observed: r.prompt?.state ?? (r.timeout ? "TIMEOUT" : "ready") });
  stopApp();

  // 2 — reinstall → Open existing
  const m0 = meta();
  const reinstall1 = randomUUID();
  reg.set(reinstall1);
  r = await launch();
  check("2a reinstall shows PRIOR_DATA_FOUND", r.prompt?.state === "PRIOR_DATA_FOUND", { observed: r.prompt?.state });
  check("5a PRIOR_DATA_FOUND offers exactly Open existing / Restore / Start new",
    JSON.stringify(r.prompt?.options) === JSON.stringify(["open_existing", "restore_backup", "start_new"]) &&
      JSON.stringify(r.screen?.buttons) === JSON.stringify(["فتح البيانات الموجودة", "استعادة نسخة احتياطية", "بدء مشروع جديد"]),
    { options: r.prompt?.options, buttons: r.screen?.buttons });
  check("5b no corruption wording outside CORRUPT", !CORRUPTION.test(`${r.screen?.title} ${r.screen?.why}`), { title: r.screen?.title });
  await r.c?.evaluate(`document.querySelector("#s-options button").click(), true`);
  r.c?.close();
  const ready2 = await waitReady();
  stopApp();
  const m2 = meta();
  check("2b Open existing opens the SAME company", ready2 && m2.data_id === m0.data_id, { before: m0.data_id, after: m2.data_id });
  // the installation must be KNOWN to the database: its creator, or adopted (a same-device reinstall
  // keeps the device binding, so it is the creator and is not appended a second time)
  const myInstallation = JSON.parse(readFileSync(join(ROOT, "db-meta.json"), "utf8")).installation_id;
  const knownBy = new Set([m2.created_by_installation_id, ...JSON.parse(m2.adopted_installation_ids)]);
  check("2c the new install instance is recorded and this installation is known",
    m2.install_instance_id === reinstall1 && knownBy.has(myInstallation),
    { recorded: m2.install_instance_id === reinstall1, known: knownBy.has(myInstallation) });
  r = await launch();
  check("2d the next restart is REUSE with no prompt", r.ready, { observed: r.prompt?.state ?? (r.timeout ? "TIMEOUT" : "ready") });
  stopApp();

  // 3 — update hand-off
  const version = JSON.parse(readFileSync(join(here, "../../desktop/src-tauri/tauri.conf.json"), "utf8")).version;
  const updated = randomUUID();
  writeFileSync(join(ROOT, "pending-update.json"), JSON.stringify({ installInstanceId: reinstall1, fromVersion: "0.0.0", toVersion: version, createdAt: new Date().toISOString() }));
  reg.set(updated);
  r = await launch();
  const m3 = meta();
  check("3a an update with a valid hand-off token is REUSE with no prompt", r.ready, { observed: r.prompt?.state ?? (r.timeout ? "TIMEOUT" : "ready") });
  stopApp();
  const m3b = meta();
  check("3b the token is consumed and the new instance recorded",
    !existsSync(join(ROOT, "pending-update.json")) && m3b.install_instance_id === updated && m3b.data_id === m0.data_id,
    { tokenLeft: existsSync(join(ROOT, "pending-update.json")), recorded: m3b.install_instance_id === updated, sameData: m3.data_id === m0.data_id });

  // 4 — reinstall → Start new
  const asideBefore = existsSync(join(ROOT, "set-aside")) ? readdirSync(join(ROOT, "set-aside")).length : 0;
  const dbBytes = statSync(join(ROOT, "data", "motard.db")).size;
  reg.set(randomUUID());
  r = await launch();
  check("4a reinstall again shows PRIOR_DATA_FOUND", r.prompt?.state === "PRIOR_DATA_FOUND", { observed: r.prompt?.state });
  await r.c?.evaluate(`Array.from(document.querySelectorAll("#s-options button")).find(b => b.textContent === "بدء مشروع جديد").click(), true`);
  r.c?.close();
  const ready4 = await waitReady();
  stopApp();
  const m4 = meta();
  const asides = existsSync(join(ROOT, "set-aside")) ? readdirSync(join(ROOT, "set-aside")) : [];
  const newest = join(ROOT, "set-aside", asides.sort().at(-1) ?? "none");
  check("4b Start new creates a NEW company", ready4 && m4.data_id !== m0.data_id, { newDataId: m4.data_id !== m0.data_id });
  check("4c the previous data is kept in set-aside, not deleted",
    asides.length === asideBefore + 1 && existsSync(join(newest, "data", "motard.db")) && statSync(join(newest, "data", "motard.db")).size >= dbBytes - 4096,
    { setAside: asides.length - asideBefore });
} finally {
  stopApp();
  if (originalMarker) reg.set(originalMarker);
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (args.out) writeFileSync(args.out, JSON.stringify({ exe: EXE, ranAt: new Date().toISOString(), results }, null, 2));
process.exit(failed ? 1 : 0);
