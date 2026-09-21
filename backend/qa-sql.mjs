/**
 * QA helper: run arbitrary SQL against a chosen database.
 * Usage: node qa-sql.mjs <dbUrlKey> <sql...>
 *   dbUrlKey: "admin" (postgres db) | "qa" (erp_acceptance) | or full connection string
 */
import pg from "pg";

const URLS = {
  admin: "postgresql://postgres:postgres@localhost:5432/postgres",
  qa: "postgresql://postgres:postgres@localhost:5432/erp_acceptance",
};

const key = process.argv[2];
const sql = process.argv.slice(3).join(" ");
const url = URLS[key] ?? key;

if (!sql) {
  console.error("usage: node qa-sql.mjs <admin|qa|connstring> <sql>");
  process.exit(2);
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const r = await c.query(sql);
  if (r.rows) console.log(JSON.stringify(r.rows, null, 1));
  else console.log("rowCount:", r.rowCount);
} finally {
  await c.end();
}
