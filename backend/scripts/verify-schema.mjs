#!/usr/bin/env node
/**
 * REPAIR-025 — print fingerprint diff (read-only).
 * Usage: node backend/scripts/verify-schema.mjs --url <DATABASE_URL>
 */
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const urlIdx = process.argv.indexOf("--url");
const DATABASE_URL =
  (urlIdx !== -1 ? process.argv[urlIdx + 1] : undefined) ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("pass --url or DATABASE_URL");
  process.exit(2);
}

const META = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "infrastructure",
  "orm",
  "migrations",
  "meta",
  "schema-fingerprint.json",
);

function normalizeDef(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const idx = await client.query(
    `SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public'`,
  );
  const liveIndexes = {};
  for (const row of idx.rows) {
    liveIndexes[row.indexname] = normalizeDef(row.indexdef);
  }
  if (!existsSync(META)) {
    console.log("No committed fingerprint yet — listing live index count:", Object.keys(liveIndexes).length);
    process.exit(0);
  }
  const expected = JSON.parse(readFileSync(META, "utf8"));
  const missing = [];
  const changed = [];
  for (const [name, meta] of Object.entries(expected.indexes ?? {})) {
    if (!(name in liveIndexes)) missing.push(name);
    else if (liveIndexes[name] !== normalizeDef(meta.definition)) changed.push(name);
  }
  console.log(JSON.stringify({ missing, changed, extraIgnored: true }, null, 2));
  process.exit(missing.length || changed.length ? 1 : 0);
} finally {
  await client.end();
}
