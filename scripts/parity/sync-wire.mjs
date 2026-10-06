#!/usr/bin/env node
/**
 * Golden sync wire test (specs/001-desktop-sqlite-engine T103, contracts/sync-wire-compat.md).
 *
 * Runs the AC-8 A/B scenario twice against an unchanged PostgreSQL hub:
 *   1. PostgreSQL desktops → hub #1
 *   2. SQLite desktops     → hub #2
 * and compares, under the parity canonicalization (sorted keys, UUIDs labelled by first appearance,
 * timestamps as instants/ranks, exact money):
 *   - every device↔hub exchange captured by the recording proxies (push batches, pull pages,
 *     number-block calls, with request and response bodies), in order;
 *   - the scenario log (sync-run results, conflict resolution, final sync status);
 *   - every table of the hub and of both devices after convergence.
 *
 *   node scripts/parity/sync-wire.mjs [--refresh-template] [--keep]
 * Exit 0 = empty diff. Outputs: scripts/parity/out/sync-wire/{postgres,sqlite}/{api,tables}.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runAc8 } from "./lib/syncAc8.mjs";
import { canonicalize } from "./lib/canonical.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = join(here, "out", "sync-wire");
const refreshTemplate = process.argv.includes("--refresh-template");
const keep = process.argv.includes("--keep");

const runs = {};
for (const [engine, basePort] of [["postgres", 8200], ["sqlite", 8210]]) {
  console.log(`[sync-wire] ${engine} desktops → PostgreSQL hub`);
  const r = await runAc8({ deviceEngine: engine, basePort, refreshTemplate: refreshTemplate && engine === "postgres", keep });
  const tables = {};
  for (const node of ["hub", "a", "b"]) for (const [t, rows] of Object.entries(r.tables[node])) tables[`${node}.${t}`] = rows;
  // Proxy ports, hub URLs and request ids differ between the two runs by construction.
  const scrub = (v) => JSON.parse(JSON.stringify(v).replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"));
  // The hub reachability probe (`probeHubReachable`, TTL-cached) fires on wall-clock age, not on a
  // sync step: whether one lands between two pushes is timing on either engine. It is not sync wire.
  const wire = r.wire.filter((x) => x.path !== "/api/health/live");
  const canon = canonicalize({ transcript: { "01-wire": scrub(wire), "02-scenario": scrub(r.log), "03-conflicts": scrub(r.conflicts) }, tables });
  // Activity notifications are a device-local feed whose ids nothing references; tables are read
  // without ORDER BY, so their physical order (PG heap vs SQLite primary key) is not behavior.
  // Compare them as a multiset.
  for (const k of Object.keys(canon.tables)) {
    if (!k.endsWith(".notifications")) continue;
    canon.tables[k] = canon.tables[k].map((row) => ({ ...row, id: "<row>" })).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  }
  const out = join(outRoot, engine);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "api"), { recursive: true });
  mkdirSync(join(out, "tables"), { recursive: true });
  for (const [k, v] of Object.entries(canon.transcript)) writeFileSync(join(out, "api", `${k}.json`), JSON.stringify(v, null, 2));
  for (const [k, v] of Object.entries(canon.tables)) writeFileSync(join(out, "tables", `${k}.json`), JSON.stringify(v, null, 2));
  runs[engine] = { exchanges: r.wire.length, out };
  console.log(`[sync-wire] ${engine}: ${r.wire.length} exchanges captured → ${out}`);
}

const d = spawnSync(process.execPath, [join(here, "diff.mjs"), runs.postgres.out, runs.sqlite.out], { encoding: "utf8" });
writeFileSync(join(outRoot, "diff.txt"), (d.stdout ?? "") + (d.stderr ?? ""));
process.stdout.write(d.stdout ?? "");
process.stderr.write(d.stderr ?? "");
process.exit(d.status ?? 1);
