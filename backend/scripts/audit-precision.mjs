#!/usr/bin/env node
/**
 * REPAIR-009 — read-only precision audit of sync payloads.
 * Counts money fields with >2 decimals in sync_outbox / sync_inbox JSON.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(2);
}

function walk(obj, path, hits) {
  if (obj == null) return;
  if (typeof obj === "number" && Number.isFinite(obj)) {
    if (Math.abs(obj * 100 - Math.round(obj * 100)) >= 1e-9) {
      hits.push({ path, value: obj });
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, `${path}[${i}]`, hits));
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k, hits);
  }
}

const c = new pg.Client({ connectionString: DATABASE_URL });
await c.connect();
try {
  const tables = ["sync_outbox", "sync_inbox"];
  let total = 0;
  for (const t of tables) {
    const exists = await c.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]);
    if (!exists.rows[0]?.r) continue;
    const rows = await c.query(`SELECT id, payload FROM ${t} LIMIT 5000`);
    for (const row of rows.rows) {
      const hits = [];
      walk(row.payload, "", hits);
      if (hits.length) {
        total += hits.length;
        console.log(`${t} ${row.id}: ${hits.length} >2dp values`);
      }
    }
  }
  console.log(`audit-precision: ${total} hits`);
  process.exit(0);
} finally {
  await c.end();
}
