#!/usr/bin/env node
/**
 * Desktop data persistence check across a real Windows shutdown / power loss.
 *
 *   node persistence-check.mjs save    [file]   (before shutting Windows down, app running)
 *   node persistence-check.mjs compare [file]   (after the next boot, app running again)
 *
 * Proves, with evidence rather than "the app opened":
 *   - SAME PostgreSQL cluster: pg_control system_identifier is minted by initdb
 *     and never changes; a recreated/replaced cluster gets a new one.
 *   - SAME `erp` database: its oid changes if the database is dropped/recreated.
 *   - SAME data directory + db-meta.json identity.
 *   - SAME data: row count + md5 of every row of every company table.
 *   - a real reboot happened in between (Windows LastBootUpTime differs).
 *
 * Read-only: it never writes to the database. Needs the app running (postgres up).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "..", "backend", "package.json"));
const pg = require("pg");

const [, , mode = "save", fileArg] = process.argv;
const DATA = path.join(process.env.LOCALAPPDATA, "motard-erp");
const file = fileArg ?? path.join(process.env.USERPROFILE, "Documents", "motard-persistence-before.json");

function ps(cmd) {
  return execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
}
function dbPassword() {
  return ps(
    `Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes('${path.join(DATA, "secrets.dat")}'); ` +
      `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); ` +
      `([Text.Encoding]::UTF8.GetString($p) | ConvertFrom-Json).db_password`,
  );
}

async function snapshot() {
  const port = Number(fs.readFileSync(path.join(DATA, "db-port.txt"), "utf8").trim());
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: dbPassword(), database: "erp" });
  await c.connect();
  await c.query("SET TimeZone TO 'UTC'");
  const q1 = async (sql) => (await c.query(sql)).rows[0];
  const identity = {
    dataDirectory: (await q1("SHOW data_directory")).data_directory,
    systemIdentifier: String((await q1("SELECT system_identifier FROM pg_control_system()")).system_identifier),
    erpDatabaseOid: (await q1("SELECT oid::text FROM pg_database WHERE datname = 'erp'")).oid,
    dbMeta: fs.existsSync(path.join(DATA, "db-meta.json")) ? JSON.parse(fs.readFileSync(path.join(DATA, "db-meta.json"), "utf8")) : null,
  };
  const { rows: tables } = await c.query(
    `SELECT t.table_name AS n FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
                     AND c.table_name = t.table_name AND c.column_name = 'tenant_id')
      ORDER BY 1`,
  );
  const data = {};
  for (const { n } of tables) {
    // written by the app on its own at every start/login — compared as "grew or equal"
    const r = await q1(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(x)::text, E'\\n' ORDER BY row_to_json(x)::text)), '') AS h FROM "${n}" x`,
    );
    data[n] = r;
  }
  const money = {
    invoices: await q1(`SELECT count(*)::int n, coalesce(sum(total),0)::text total, coalesce(sum(paid),0)::text paid FROM invoices WHERE status='active'`),
    ledger: await q1(`SELECT count(*)::int n, coalesce(sum(debit),0)::text debit, coalesce(sum(credit),0)::text credit FROM ledger_entries WHERE status='active'`),
    vouchers: await q1(`SELECT count(*)::int n, coalesce(sum(amount),0)::text amount FROM vouchers WHERE status='active'`),
    stockKg: await q1(`SELECT count(*)::int n, coalesce(sum(remaining_kg),0)::text kg FROM rolls`),
  };
  await c.end();
  return {
    takenAt: new Date().toISOString(),
    windowsLastBoot: ps("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"),
    identity,
    money,
    data,
  };
}

// Tables the app appends to by itself (sessions, audit of the login itself…).
const APP_WRITES = new Set(["audit_logs", "notifications", "idempotency_keys", "revoked_tokens", "device_registrations", "sync_devices", "license_activations", "license_audit_events"]);

const now = await snapshot();
if (mode === "save") {
  fs.writeFileSync(file, JSON.stringify(now, null, 2));
  console.log(`saved ${file}`);
  console.log(`cluster ${now.identity.systemIdentifier}, erp oid ${now.identity.erpDatabaseOid}, invoices ${now.money.invoices.n}, ledger ${now.money.ledger.n}`);
  process.exit(0);
}
const before = JSON.parse(fs.readFileSync(file, "utf8"));
const problems = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) problems.push(label);
};
check("Windows was restarted in between", now.windowsLastBoot !== before.windowsLastBoot, `${before.windowsLastBoot} -> ${now.windowsLastBoot}`);
check("same data directory", now.identity.dataDirectory === before.identity.dataDirectory, now.identity.dataDirectory);
check("same PostgreSQL cluster (system_identifier)", now.identity.systemIdentifier === before.identity.systemIdentifier, now.identity.systemIdentifier);
check("same `erp` database (oid)", now.identity.erpDatabaseOid === before.identity.erpDatabaseOid, now.identity.erpDatabaseOid);
check("same installation identity (db-meta.json)", now.identity.dbMeta?.installation_id === before.identity.dbMeta?.installation_id);
for (const k of Object.keys(before.money)) {
  check(`totals unchanged: ${k}`, JSON.stringify(now.money[k]) === JSON.stringify(before.money[k]), JSON.stringify(now.money[k]));
}
let same = 0;
for (const [t, b] of Object.entries(before.data)) {
  const a = now.data[t];
  if (APP_WRITES.has(t)) {
    check(`${t}: nothing lost`, a && a.n >= b.n, `${b.n} -> ${a?.n}`);
  } else if (!a || a.n !== b.n || a.h !== b.h) {
    check(`${t}: identical rows`, false, `${b.n} -> ${a?.n}`);
  } else same++;
}
console.log(`${same} tables byte-identical (row count + md5 of every row)`);
console.log(problems.length ? `\nRESULT: FAIL (${problems.length})` : "\nRESULT: PASS — same database, same data after the restart");
process.exit(problems.length ? 1 : 0);
