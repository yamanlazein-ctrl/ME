#!/usr/bin/env node
/**
 * REPAIR-025 — generate schema-fingerprint.json from a disposable migrated DB.
 * Usage: node backend/scripts/schema-fingerprint.mjs [--url DATABASE_URL]
 * Writes: backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "src", "infrastructure", "orm", "migrations");
const OUT = join(MIGRATIONS, "meta", "schema-fingerprint.json");

const urlArg = process.argv.indexOf("--url");
const DATABASE_URL =
  (urlArg !== -1 ? process.argv[urlArg + 1] : undefined) ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/erp_fingerprint";

function normalizeDef(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}

async function readLive(client) {
  const tables = {};
  const t = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable,
           pg_get_expr(ad.adbin, ad.adrelid) AS col_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`);
  for (const row of t.rows) {
    tables[row.table_name] ??= { columns: {} };
    tables[row.table_name].columns[row.column_name] = {
      type: row.data_type,
      nullable: row.nullable,
      default: row.col_default,
    };
  }
  const indexes = {};
  for (const row of (
    await client.query(`SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public'`)
  ).rows) {
    indexes[row.indexname] = { table: row.tablename, definition: normalizeDef(row.indexdef) };
  }
  const constraints = {};
  for (const row of (
    await client.query(`
      SELECT con.conname, rel.relname AS table_name, con.contype, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname='public'`)
  ).rows) {
    constraints[row.conname] = {
      table: row.table_name,
      type: row.contype,
      definition: normalizeDef(row.definition),
    };
  }
  const policies = {};
  for (const row of (
    await client.query(
      `SELECT schemaname||'.'||tablename||'.'||policyname AS key, cmd, qual, with_check FROM pg_policies WHERE schemaname='public'`,
    )
  ).rows) {
    policies[row.key] = { cmd: row.cmd, using: row.qual, withCheck: row.with_check };
  }
  const rls = {};
  for (const row of (
    await client.query(`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r'`)
  ).rows) {
    rls[row.relname] = { enabled: row.enabled, forced: row.forced };
  }
  const triggers = {};
  for (const row of (
    await client.query(`
      SELECT t.tgname, c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT t.tgisinternal`)
  ).rows) {
    triggers[row.tgname] = { table: row.table_name, definition: normalizeDef(row.definition) };
  }
  const functions = {};
  for (const row of (
    await client.query(`
      SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`)
  ).rows) {
    functions[row.proname] = createHash("sha256").update(row.prosrc ?? "").digest("hex");
  }
  const enums = {};
  for (const row of (
    await client.query(`
      SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
        JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
       ORDER BY t.typname, e.enumsortorder`)
  ).rows) {
    enums[row.typname] ??= [];
    enums[row.typname].push(row.enumlabel);
  }
  const extensions = (
    await client.query(`SELECT extname FROM pg_extension ORDER BY 1`)
  ).rows.map((r) => r.extname);

  let journalIdx = 0;
  const journalPath = join(MIGRATIONS, "meta", "_journal.json");
  if (existsSync(journalPath)) {
    const j = JSON.parse(readFileSync(journalPath, "utf8"));
    journalIdx = j.entries?.at(-1)?.idx ?? 0;
  }

  const body = { journalIdx, tables, indexes, constraints, policies, rls, triggers, functions, enums, extensions };
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, generatedAt: new Date().toISOString(), sha256 };
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const fp = await readLive(client);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(fp, null, 2)}\n`);
  console.log(`[schema-fingerprint] wrote ${OUT} sha256=${fp.sha256.slice(0, 12)}…`);
} finally {
  await client.end();
}
