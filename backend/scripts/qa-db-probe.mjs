import "dotenv/config";
import pg from "pg";

const admin = process.env.ADMIN_DATABASE_URL;
const app = process.env.DATABASE_URL;
console.log("has_ADMIN", !!admin);
console.log("has_APP", !!app);
const url = admin || app;
if (!url) {
  console.error("NO_URL");
  process.exit(1);
}
const u = new URL(url);
console.log("using_db", u.pathname.slice(1), "host", u.hostname, "user", u.username);
const c = new pg.Client({ connectionString: url });
await c.connect();
const r = await c.query(
  "SELECT current_user AS usr, current_database() AS db, (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables",
);
console.log(r.rows[0]);
for (const t of ["tenants", "users", "fabrics", "invoices", "settings", "licenses"]) {
  try {
    const q = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
    console.log(t, q.rows[0].n);
  } catch (e) {
    console.log(t, "ERR", e.message);
  }
}
try {
  const users = await c.query("SELECT id, username FROM users LIMIT 5");
  console.log("users_sample", users.rows);
} catch (e) {
  console.log("users_sample_err", e.message);
}
await c.end();
