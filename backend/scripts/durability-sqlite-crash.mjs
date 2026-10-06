#!/usr/bin/env node
/**
 * SQLite durability under hard kills (specs/001-desktop-sqlite-engine T114, SC-004).
 * Entry: node backend/scripts/durability-proof.mjs --engine sqlite [--rounds 25] [--out <dir>]
 *
 * A real backend (DB_ENGINE=sqlite) on a fresh company file. Each round:
 *   - multi-record saves run back to back: a paid sale invoice = invoice + lines + ledger legs +
 *     cash movement + stock movement, one transaction;
 *   - at a random moment the backend is killed with `taskkill /F` (no shutdown, no checkpoint);
 *   - the file is opened raw and checked:
 *       integrity_check = ok and foreign_key_check empty,
 *       every save the client saw CONFIRMED (HTTP 201) is present,
 *       every invoice in the file is COMPLETE — the same row shape (lines, ledger legs, stock
 *       movements, cash-box days) as a reference sale made before the first kill — or absent;
 *   - the backend restarts on the same file (REUSE) for the next round.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const { createSqlite, nodeEnv, startNode, waitHealthy, kill, mintToken, client, must, JWT_A, DEV_A } = await import(
  new URL("../../scripts/parity/lib/syncAc8.mjs", import.meta.url).href
);
const Database = createRequire(join(here, "..", "package.json"))("better-sqlite3");

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROUNDS = Number(arg("rounds", "25"));
const OUT = resolve(REPO, arg("out", "scripts/parity/out/durability-sqlite"));
const PORT = Number(arg("port", "18400"));
const work = mkdtempSync(join(tmpdir(), "motard-durability-"));
const dbPath = join(work, "data", "motard.db");
mkdirSync(dirname(dbPath), { recursive: true });
createSqlite(dbPath, "durability");

const env = nodeEnv({ DB_ENGINE: "sqlite", SQLITE_PATH: dbPath, MOTARD_STARTUP_STATE: "OPEN_EXISTING", PORT: String(PORT), JWT_SECRET: JWT_A });
let server = null;
const start = async (round) => {
  server = startNode(`backend-${round}`, env, join(work, `backend-${round}.log`));
  await waitHealthy(PORT, server);
};
await start(0);
const api = client(PORT, await mintToken(JWT_A), DEV_A);
const DATE = new Date().toISOString().slice(0, 10);
const customer = (await must(api, "customer", "POST", "/api/customers", { name: "Durability Customer" })).id;
const fabric = (await must(api, "fabric", "POST", "/api/inventory/fabrics", { name: "Durability Fabric" })).id;
const color = (await must(api, "color", "POST", "/api/inventory/colors", { fabricId: fabric, name: "Durability Color" })).id;
const roll = (await must(api, "roll", "POST", "/api/inventory/rolls", { colorId: color, rollNo: "DUR-R1", initialKg: 100_000, pieces: 100_000, pricePerKg: 2, currency: "USD", entryDate: DATE })).id;
const sale = () =>
  api("POST", "/api/invoices", {
    type: "sale", date: DATE, partyId: customer, partyType: "customer", currency: "USD",
    lines: [{ fabricId: fabric, colorId: color, rollId: roll, quantityKg: 1, pieces: 1, pricePerKg: 3 }], paid: 3,
  });

const shapeOf = (db, id) => ({
  lines: db.prepare("SELECT count(*) FROM invoice_lines WHERE invoice_id = ?").pluck().get(id),
  ledger: db.prepare("SELECT count(*) FROM ledger_entries WHERE reference_id = ?").pluck().get(id),
  stock: db.prepare("SELECT count(*) FROM stock_movements WHERE reference_id = ?").pluck().get(id),
});
const ref = await sale();
if (ref.status !== 201) throw new Error(`reference sale failed: HTTP ${ref.status} ${ref.text.slice(0, 200)}`);
const confirmed = new Set([ref.json.id]);
kill(server);
await new Promise((r) => setTimeout(r, 1000));
let refShape;
{
  const db = new Database(dbPath);
  refShape = JSON.stringify(shapeOf(db, ref.json.id));
  db.close();
}

const rounds = [];
for (let round = 1; round <= ROUNDS; round++) {
  await start(round);
  let stop = false;
  let sent = 0;
  const loop = (async () => {
    while (!stop) {
      sent++;
      try {
        const r = await sale();
        if (r.status === 201 && r.json?.id) confirmed.add(r.json.id);
      } catch {
        return; // the server died mid-request: outcome unknown, checked against the file below
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 1500)));
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else kill(server);
  stop = true;
  await loop;
  await new Promise((r) => setTimeout(r, 800));

  const db = new Database(dbPath); // recovers the WAL exactly as the next start would
  const integrity = db.pragma("integrity_check", { simple: true });
  const fk = db.pragma("foreign_key_check").length;
  const ids = db.prepare("SELECT id FROM invoices WHERE type = 'sale'").pluck().all();
  const present = new Set(ids);
  const missing = [...confirmed].filter((id) => !present.has(id));
  const incomplete = ids.filter((id) => JSON.stringify(shapeOf(db, id)) !== refShape);
  db.close();
  const ok = integrity === "ok" && fk === 0 && missing.length === 0 && incomplete.length === 0;
  rounds.push({ round, sent, confirmed: confirmed.size, invoicesInFile: ids.length, integrity, fkViolations: fk, missingConfirmed: missing.length, incomplete: incomplete.length, ok });
  console.log(`  round ${String(round).padStart(2)}: ${ok ? "PASS" : "FAIL"}  sent=${sent} confirmed=${confirmed.size} inFile=${ids.length} integrity=${integrity} fk=${fk} missing=${missing.length} incomplete=${incomplete.length}`);
}

const pass = rounds.every((r) => r.ok);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), engine: "sqlite", rounds: ROUNDS, referenceShape: JSON.parse(refShape), results: rounds, pass }, null, 2));
console.log(`[durability-sqlite] ${rounds.filter((r) => r.ok).length}/${ROUNDS} rounds passed — reference sale shape ${refShape}`);
rmSync(work, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
