#!/usr/bin/env node
/**
 * Schema parity: live PostgreSQL fingerprint ↔ SQLite fingerprint
 * (specs/001-desktop-sqlite-engine, task T006, data-model.md §1).
 *
 *   node scripts/compare-schema-fingerprints.mjs <sqlite-fingerprint.json> [<pg-fingerprint.json>]
 *
 * The PG reference defaults to src/infrastructure/orm/migrations/meta/schema-fingerprint.json
 * (journal idx 99). The SQLite fingerprint is written by scripts/sqlite-schema-fingerprint.mts in
 * the same JSON shape, with constraints carrying parsed fields:
 *
 *   tables.{t}.columns.{c} = { type, nullable, default }
 *   constraints.{name}     = { table, type: "p"|"u"|"c"|"f", columns, refTable?, refColumns?, onDelete?, definition }
 *   indexes.{name}         = { table, definition }
 *   triggers.{name}        = { table, definition }
 *
 * Rules (anything else fails):
 *   - identical table set, except the SQLite-only runtime tables `motard_meta`, `motard_sequences`, `motard_tx_state`;
 *     `party_balances` must not exist (dropped by migration 0038)
 *   - identical column names and nullability per table; storage type per the R6/R5 mapping
 *   - every PG PK / UNIQUE / CHECK / FK has a same-named SQLite constraint; PK/UNIQUE/FK columns,
 *     FK target and ON DELETE action identical; extra SQLite CHECKs (length/json/boolean) allowed
 *   - no SQLite FK that PG lacks: in particular no added `tenant_id → tenants` FK (data-model §1.2)
 *   - every PG btree index has a same-named SQLite index; GIN/trigram indexes may be absent
 *   - every PG trigger has ≥1 SQLite trigger whose name starts with the PG trigger name
 *   - RLS policies, extensions and plpgsql functions are expected to be absent
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [sqPath, pgArg] = process.argv.slice(2);
if (!sqPath) {
  console.error("usage: node scripts/compare-schema-fingerprints.mjs <sqlite-fingerprint.json> [<pg-fingerprint.json>]");
  process.exit(2);
}
const pgPath = pgArg ?? join(here, "..", "src", "infrastructure", "orm", "migrations", "meta", "schema-fingerprint.json");
const pg = JSON.parse(readFileSync(pgPath, "utf8"));
const sq = JSON.parse(readFileSync(sqPath, "utf8"));

const SQLITE_ONLY_TABLES = new Set(["motard_meta", "motard_sequences", "motard_tx_state"]);
const problems = [];
const fail = (m) => problems.push(m);
const strip = (s) => s.replace(/^public\./, "");
const cols = (s) => s.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

/** PG column type → allowed SQLite declared type (research R5/R6). */
function expectedSqliteType(pgType) {
  const t = pgType.toLowerCase();
  if (t.endsWith("[]")) return "TEXT"; // arrays stored as JSON text
  if (t.startsWith("numeric")) return "INTEGER"; // scaled exact decimal
  if (["integer", "bigint", "smallint", "boolean"].includes(t)) return "INTEGER";
  if (t === "uuid" || t === "text" || t.startsWith("character varying") || t.startsWith("character(")
    || t.startsWith("timestamp") || t === "date" || t === "jsonb" || t === "json" || t === "inet") return "TEXT";
  return null;
}

function parsePgConstraint(c) {
  const d = c.definition.toLowerCase();
  if (c.type === "p" || c.type === "u") {
    const m = d.match(/\(([^)]+)\)/);
    return { ...c, columns: m ? cols(m[1]) : [] };
  }
  if (c.type === "f") {
    const m = d.match(/foreign key \(([^)]+)\) references ([a-z_0-9."]+)\(([^)]+)\)(.*)$/);
    if (!m) return { ...c, columns: [] };
    const del = m[4].match(/on delete (set null|cascade|restrict|set default|no action)/);
    return { ...c, columns: cols(m[1]), refTable: strip(m[2].replace(/"/g, "")), refColumns: cols(m[3]), onDelete: del ? del[1] : "no action" };
  }
  return c;
}

// ── tables ──────────────────────────────────────────────────────────────────
const pgTables = new Set(Object.keys(pg.tables).map(strip));
const sqTables = new Set(Object.keys(sq.tables));
if (sqTables.has("party_balances")) fail("table party_balances exists — it was dropped by migration 0038");
for (const t of pgTables) if (!sqTables.has(t)) fail(`table ${t}: missing in SQLite`);
for (const t of sqTables) if (!pgTables.has(t) && !SQLITE_ONLY_TABLES.has(t)) fail(`table ${t}: not in the live PG schema`);

// ── columns ─────────────────────────────────────────────────────────────────
for (const t of pgTables) {
  const pc = pg.tables[t]?.columns ?? pg.tables[`public.${t}`]?.columns ?? {};
  const sc = sq.tables[t]?.columns;
  if (!sc) continue;
  for (const [name, def] of Object.entries(pc)) {
    const s = sc[name];
    if (!s) { fail(`${t}.${name}: column missing in SQLite`); continue; }
    if (Boolean(s.nullable) !== Boolean(def.nullable)) fail(`${t}.${name}: nullable ${def.nullable} → ${s.nullable}`);
    const want = expectedSqliteType(def.type);
    if (!want) fail(`${t}.${name}: no SQLite mapping for PG type ${def.type}`);
    else if (String(s.type).toUpperCase() !== want) fail(`${t}.${name}: PG ${def.type} expects SQLite ${want}, got ${s.type}`);
  }
  for (const name of Object.keys(sc)) if (!(name in pc)) fail(`${t}.${name}: extra column in SQLite`);
}

// ── constraints ─────────────────────────────────────────────────────────────
const pgCons = Object.entries(pg.constraints).map(([name, c]) => [name, parsePgConstraint({ ...c, table: strip(c.table) })]);
const sqCons = sq.constraints ?? {};
const same = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);
for (const [name, c] of pgCons) {
  const s = sqCons[name];
  if (!s) { fail(`constraint ${name} (${c.type} on ${c.table}): missing in SQLite`); continue; }
  if (s.table !== c.table || s.type !== c.type) { fail(`constraint ${name}: ${c.type}@${c.table} → ${s.type}@${s.table}`); continue; }
  if ((c.type === "p" || c.type === "u" || c.type === "f") && !same(c.columns, s.columns)) fail(`constraint ${name}: columns (${c.columns}) → (${s.columns})`);
  if (c.type === "f") {
    if (s.refTable !== c.refTable || !same(c.refColumns, s.refColumns)) fail(`constraint ${name}: references ${c.refTable}(${c.refColumns}) → ${s.refTable}(${s.refColumns})`);
    if ((s.onDelete ?? "no action") !== c.onDelete) fail(`constraint ${name}: on delete ${c.onDelete} → ${s.onDelete}`);
  }
}
const pgConNames = new Set(pgCons.map(([n]) => n));
for (const [name, s] of Object.entries(sqCons)) {
  if (pgConNames.has(name)) continue;
  if (SQLITE_ONLY_TABLES.has(s.table) && s.type !== "f") continue; // runtime tables' own PK/CHECKs
  if (s.type === "f") fail(`constraint ${name}: FK ${s.table}(${s.columns}) → ${s.refTable} not in the live PG schema${s.refTable === "tenants" ? " (non-enforced tenant reference must stay non-enforced)" : ""}`);
  if (s.type === "p" || s.type === "u") fail(`constraint ${name}: extra ${s.type === "p" ? "PRIMARY KEY" : "UNIQUE"} on ${s.table}`);
  // extra CHECKs (length / json_valid / boolean) are allowed
}

// ── indexes ─────────────────────────────────────────────────────────────────
const sqIdx = sq.indexes ?? {};
for (const [name, ix] of Object.entries(pg.indexes)) {
  const def = ix.definition.toLowerCase();
  if (/using gin/.test(def)) continue; // trigram/GIN: allowed absent (research R7/R9)
  if (pgConNames.has(name)) continue; // PK/UNIQUE-backed index: covered by the constraint
  if (!sqIdx[name]) fail(`index ${name} on ${strip(ix.table)}: missing in SQLite`);
}

// ── triggers ────────────────────────────────────────────────────────────────
const sqTrg = Object.keys(sq.triggers ?? {});
for (const name of Object.keys(pg.triggers)) {
  if (!sqTrg.some((s) => s === name || s.startsWith(`${name}_`))) fail(`trigger ${name}: no SQLite equivalent`);
}

const summary = `PG ${pgTables.size} tables / ${pgCons.filter(([, c]) => c.type === "f").length} FKs  ↔  SQLite ${sqTables.size} tables / ${Object.values(sqCons).filter((c) => c.type === "f").length} FKs`;
if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(`[schema-parity] FAIL — ${problems.length} problem(s). ${summary}`);
  process.exit(1);
}
console.log(`[schema-parity] PASS — only allowed deltas. ${summary}`);
