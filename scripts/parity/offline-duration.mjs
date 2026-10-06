#!/usr/bin/env node
/**
 * Long-offline test (specs/001-desktop-sqlite-engine T104; spec FR-055, SY-2; T016/I-17 findings).
 *
 *   node scripts/parity/offline-duration.mjs
 *
 * For each desktop engine (PostgreSQL reference, then SQLite) against an unchanged PostgreSQL hub:
 *   1. online: the device reserves its number blocks; then the hub becomes UNREACHABLE (the proxy in
 *      front of it refuses every connection);
 *   2. the clock moves to +1, +7, +30 and +90 days (hub and device together, as real time would). At
 *      each step the device creates a sale invoice, cancels the previous one, records a receipt and a
 *      stock-in (new roll), and reads the customer statement, its sync status and its licence
 *      status — every answer is recorded;
 *   3. the hub becomes reachable again; the device syncs until drained and must hold the same
 *      business state as the hub.
 * Then the two engines' transcripts are compared under the parity canonicalization (empty diff).
 *
 * Asserted: no offline step is refused (no new offline limit in ERP work, sync or licensing), the
 * engines behave identically, and sync converges after 90 days offline. The clock shift is a test
 * preload (lib/clockShift.mjs); production code is unchanged.
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  pgAdminUrl, dbUrl, withClient, ensurePgTemplate, clonePg, seedPg, createSqlite, nodeEnv, startNode, waitHealthy, kill,
  client, must, syncUntilDrained, businessState, diffStates, TENANT_ID, USER_ID, DEV_A, JWT_HUB, JWT_A,
} from "./lib/syncAc8.mjs";
import { BACKEND, readTables } from "./lib/engine.mjs";
import { canonicalize } from "./lib/canonical.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { SignJWT } = createRequire(join(BACKEND, "package.json"))("jose");
const DAY = 86_400_000;
const STEPS = [1, 7, 30, 90];
const CLOCK_PRELOAD = `--import=${pathToFileURL(join(here, "lib", "clockShift.mjs")).href}`;

/** Tokens outlive the 90-day jump: the test is about offline rules, not session lifetime. */
async function longToken(secret) {
  return new SignJWT({ sub: USER_ID, tenantId: TENANT_ID, role: "admin", jti: randomUUID(), type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 120 * 86_400)
    .sign(new TextEncoder().encode(secret));
}

/** Reverse proxy with an online switch (offline = connections are destroyed, like no network). */
function switchProxy(port, hubPort) {
  const state = { online: true };
  const server = createServer((req, res) => {
    if (!state.online) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      try {
        const r = await fetch(`http://127.0.0.1:${hubPort}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
        });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(text);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function runEngine(engine, basePort) {
  const ports = { hub: basePort + 1, dev: basePort + 2, proxy: basePort + 3 };
  const admin = pgAdminUrl();
  const tag = `${engine === "sqlite" ? "sq" : "pg"}_${Date.now()}`;
  const dbs = { hub: `offline_hub_${tag}`, dev: `offline_dev_${tag}` };
  const work = mkdtempSync(join(tmpdir(), `motard-offline-${engine}-`));
  const clockFile = join(work, "clock-offset-ms.txt");
  writeFileSync(clockFile, "0");
  const shifted = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${CLOCK_PRELOAD}`.trim(), MOTARD_CLOCK_SHIFT_FILE: clockFile };
  const children = [];
  const transcript = [];
  const checks = [];
  const check = (name, pass, detail = "") => {
    checks.push({ name, pass, detail });
    console.log(`  [${engine}] ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  let proxy;
  try {
    await ensurePgTemplate(admin, false);
    await clonePg(admin, dbs.hub);
    await seedPg(dbUrl(admin, dbs.hub), "hub");
    let devHandle;
    if (engine === "sqlite") {
      const path = join(work, "dev", "motard.db");
      mkdirSync(dirname(path), { recursive: true });
      createSqlite(path, "dev");
      devHandle = { engine: "sqlite", env: { SQLITE_PATH: path } };
    } else {
      await clonePg(admin, dbs.dev);
      await seedPg(dbUrl(admin, dbs.dev), "dev");
      devHandle = { engine: "postgres", env: { DATABASE_URL: dbUrl(admin, dbs.dev) } };
    }
    const hubHandle = { engine: "postgres", env: { DATABASE_URL: dbUrl(admin, dbs.hub) } };

    const hub = startNode("hub", nodeEnv({ ...shifted, DB_ENGINE: "postgres", DATABASE_URL: hubHandle.env.DATABASE_URL, PORT: String(ports.hub), JWT_SECRET: JWT_HUB }), join(work, "hub.log"));
    children.push(hub);
    await waitHealthy(ports.hub, hub);
    proxy = await switchProxy(ports.proxy, ports.hub);
    const engineEnv = engine === "sqlite"
      ? { DB_ENGINE: "sqlite", SQLITE_PATH: devHandle.env.SQLITE_PATH, MOTARD_STARTUP_STATE: "OPEN_EXISTING" }
      : { DB_ENGINE: "postgres", DATABASE_URL: devHandle.env.DATABASE_URL };
    const dev = startNode("device", nodeEnv({
      ...shifted, ...engineEnv, PORT: String(ports.dev), JWT_SECRET: JWT_A,
      CENTRAL_SYNC_URL: `http://127.0.0.1:${ports.proxy}`, HUB_SYNC_ACCESS_TOKEN: await longToken(JWT_HUB),
    }), join(work, "device.log"));
    children.push(dev);
    await waitHealthy(ports.dev, dev);
    const D = client(ports.dev, await longToken(JWT_A), DEV_A);
    const rec = async (label, method, path, body) => {
      const r = await D(method, path, body);
      transcript.push({ label, method, path, status: r.status, body: r.json });
      return r;
    };

    // ── online: number blocks, then the hub disappears ──
    // Same reservation the app makes when a device registers (every document type).
    await must(D, "number blocks", "POST", "/api/sync/number-blocks/ensure", { syncDeviceId: DEV_A });
    proxy.state.online = false;

    const today = () => localDate(Date.now() + Number(currentOffset));
    let currentOffset = 0;
    const customer = (await must(D, "customer", "POST", "/api/customers", { name: "Offline Customer" })).id;
    const fabric = (await must(D, "fabric", "POST", "/api/inventory/fabrics", { name: "Offline Fabric" })).id;
    const color = (await must(D, "color", "POST", "/api/inventory/colors", { fabricId: fabric, name: "Offline Color" })).id;
    const roll = (await must(D, "roll", "POST", "/api/inventory/rolls", { colorId: color, rollNo: "OFF-R0", initialKg: 1000, pieces: 100, pricePerKg: 2, currency: "USD", entryDate: today() })).id;

    let previousInvoice = null;
    const refused = [];
    for (const days of STEPS) {
      currentOffset = days * DAY;
      writeFileSync(clockFile, String(currentOffset));
      await new Promise((r) => setTimeout(r, 400));
      const date = today();
      const steps = [
        ["invoice", "POST", "/api/invoices", { type: "sale", date, partyId: customer, partyType: "customer", currency: "USD", lines: [{ fabricId: fabric, colorId: color, rollId: roll, quantityKg: 10, pieces: 1, pricePerKg: 4 }], paid: 0 }],
        ["receipt", "POST", "/api/receipts", { kind: "receipt", date, partyId: customer, partyKind: "customer", amount: 15, currency: "USD", method: "cash" }],
        ["stock-in", "POST", "/api/inventory/rolls", { colorId: color, rollNo: `OFF-R${days}`, initialKg: 50, pieces: 5, pricePerKg: 2, currency: "USD", entryDate: date }],
      ];
      let invoiceId = null;
      for (const [what, method, path, body] of steps) {
        const r = await rec(`day${days}.${what}`, method, path, body);
        if (r.status >= 400) refused.push(`day ${days} ${what}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
        if (what === "invoice") invoiceId = r.json?.id ?? null;
      }
      if (previousInvoice) {
        const cur = await D("GET", `/api/invoices/${previousInvoice}`);
        const r = await rec(`day${days}.cancel-previous`, "POST", `/api/invoices/${previousInvoice}/cancel`, { expectedVersion: cur.json?.version, reason: "offline test" });
        if (r.status >= 400) refused.push(`day ${days} cancel: HTTP ${r.status} ${r.text.slice(0, 160)}`);
      }
      previousInvoice = invoiceId;
      for (const [what, path] of [["statement", `/api/customers/${customer}/statement?limit=500`], ["sync-status", "/api/sync/status"], ["license", "/api/license/status"]]) {
        const r = await rec(`day${days}.${what}`, "GET", path);
        if (r.status >= 400 && what !== "license") refused.push(`day ${days} ${what}: HTTP ${r.status}`);
      }
    }
    check("no ERP operation refused after 1, 7, 30 and 90 days offline", refused.length === 0, refused.join(" | "));
    const lic = transcript.filter((t) => t.label.endsWith(".license")).map((t) => `${t.label}:${t.status}`);
    check("licence status answers the same at every offline step (no offline expiry)", new Set(transcript.filter((t) => t.label.endsWith(".license")).map((t) => `${t.status}:${t.body?.license?.status ?? t.body?.status ?? ""}`)).size === 1, lic.join(", "));
    const pending = transcript.find((t) => t.label === "day90.sync-status")?.body?.pendingCount;
    check("all offline work is queued, nothing lost (outbox pending at day 90)", Number(pending) > 0, `pending=${pending}`);

    // ── reconnect ──
    proxy.state.online = true;
    const rounds = await syncUntilDrained(D, 12);
    transcript.push({ label: "reconnect.sync", recorded: rounds.map((r) => ({ pushed: r.pushed, failed: r.failed, rejected: r.rejected, pulled: r.pull?.pulled })) });
    const status = (await D("GET", "/api/sync/status")).json;
    check("outbox drained after reconnecting", status?.pendingCount === 0, JSON.stringify(status?.statusCounts ?? null));

    for (const c of children) kill(c);
    children.length = 0;
    await new Promise((r) => setTimeout(r, 1000));
    const tables = { hub: await readTables(hubHandle), dev: await readTables(devHandle) };
    // Known engine-independent behavior (US5 report, item 1): a roll's `initial` stock movement is
    // not synced, so the device's rolls carry one movement the hub does not. Everything else must match.
    // Known (US5 report, item 4): a cancellation's `cancelled_at` is the time each node APPLIED it —
    // the hub stamps the reconnect time, not the time the user cancelled offline. Reported below;
    // the rest of the state must match.
    const withoutCancelledAt = (t) => Object.fromEntries(Object.entries(t).map(([k, rows]) => [k, rows.map(({ cancelled_at, ...rest }) => rest)]));
    const devState = businessState(withoutCancelledAt({ ...tables.dev, stock_movements: tables.dev.stock_movements.filter((m) => m.movement_type !== "initial") }));
    const diff = diffStates(devState, businessState(withoutCancelledAt(tables.hub)), "device", "hub");
    check("device and hub hold identical business state after reconnecting (cancelled_at aside)", diff.length === 0, diff.join("\n      "));
    const cancelAt = (t) => Object.fromEntries(t.invoices.filter((i) => i.cancelled_at).map((i) => [i.id, i.cancelled_at]));
    const devCancel = cancelAt(tables.dev);
    const hubCancel = cancelAt(tables.hub);
    const kept = Object.keys(devCancel).filter((id) => devCancel[id] === hubCancel[id]).length;
    console.log(`  [${engine}] NOTE  cancelled_at kept on the hub for ${kept}/${Object.keys(devCancel).length} offline cancellations (the hub stamps its apply time)`);
    return { transcript, tables, checks };
  } finally {
    for (const c of children) kill(c);
    if (proxy) proxy.server.close();
    await withClient(admin, async (c) => {
      for (const db of Object.values(dbs)) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

const outRoot = join(here, "out", "offline-duration");
const results = {};
for (const [engine, basePort] of [["postgres", 8230], ["sqlite", 8240]]) {
  console.log(`[offline-duration] ${engine} desktop, hub unreachable for 90 days`);
  const r = await runEngine(engine, basePort);
  results[engine] = r;
  const tables = {};
  for (const [node, t] of Object.entries(r.tables)) for (const [name, rows] of Object.entries(t)) tables[`${node}.${name}`] = rows;
  // Hub/proxy ports differ between the two runs by construction.
  const scrubbed = JSON.parse(JSON.stringify(r.transcript).replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"));
  const canon = canonicalize({ transcript: { "01-offline": scrubbed }, tables });
  const out = join(outRoot, engine);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "api"), { recursive: true });
  mkdirSync(join(out, "tables"), { recursive: true });
  for (const [k, v] of Object.entries(canon.transcript)) writeFileSync(join(out, "api", `${k}.json`), JSON.stringify(v, null, 2));
  for (const [k, v] of Object.entries(canon.tables)) {
    // device-local activity feed and request log: order/timing only (see sync-wire.mjs)
    const bySet = (list) => list.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    // Independent documents are pushed on parallel lanes that "race each other freely"
    // (runLocalSyncPush, SYNC-16): the hub's receive/apply sequence among them is timing on
    // either engine, so the inbox is compared as a set with its sequence numbers masked.
    const rows = /\.(notifications|audit_logs)$/.test(k)
      ? bySet(v.map((row) => ({ ...row, id: "<row>" })))
      : /\.sync_inbox$/.test(k)
        ? bySet(v.map((row) => ({ ...row, received_seq: "<lane-order>", applied_seq: "<lane-order>" })))
        : v;
    writeFileSync(join(out, "tables", `${k}.json`), JSON.stringify(rows, null, 2));
  }
}
const d = spawnSync(process.execPath, [join(here, "diff.mjs"), join(outRoot, "postgres"), join(outRoot, "sqlite")], { encoding: "utf8" });
writeFileSync(join(outRoot, "diff.txt"), (d.stdout ?? "") + (d.stderr ?? ""));
const engineDiffEmpty = d.status === 0;
console.log(`  ${engineDiffEmpty ? "PASS" : "FAIL"}  PostgreSQL and SQLite desktops behave identically (canonical diff) — ${(d.stdout ?? "").trim().split("\n").at(-1)}`);
const failed = Object.values(results).flatMap((r) => r.checks.filter((c) => !c.pass)).length + (engineDiffEmpty ? 0 : 1);
writeFileSync(join(outRoot, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), checks: Object.fromEntries(Object.entries(results).map(([e, r]) => [e, r.checks])), engineDiffEmpty }, null, 2));
process.exit(failed ? 1 : 0);
