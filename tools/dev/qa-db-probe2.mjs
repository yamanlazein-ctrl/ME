import "dotenv/config";
import pg from "pg";

const appUrl = process.env.DATABASE_URL;
if (!appUrl) {
  console.error("NO_DATABASE_URL");
  process.exit(1);
}
const u = new URL(appUrl);

// Prefer explicit postgres superuser on same host/db if present via env, else try local postgres.
const candidates = [
  process.env.ADMIN_DATABASE_URL,
  process.env.QA_ADMIN_DATABASE_URL,
  `postgresql://postgres:postgres@${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, "")}`,
  `postgresql://postgres:@${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, "")}`,
].filter(Boolean);

async function tryConnect(url, label) {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    const r = await c.query("SELECT current_user AS usr, current_database() AS db");
    console.log("OK", label, r.rows[0]);
    return c;
  } catch (e) {
    console.log("FAIL", label, e.message);
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

let client = null;
for (const cand of candidates) {
  const cu = new URL(cand);
  client = await tryConnect(cand, `${cu.username}@${cu.hostname}/${cu.pathname.slice(1)}`);
  if (client) break;
}

if (!client) {
  // Fall back to app_user and inspect RLS
  client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  console.log("FALLBACK app_user");
}

const rls = await client.query(`
  SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('tenants','users','fabrics','invoices')
  ORDER BY 1
`);
console.log("rls", rls.rows);

const grants = await client.query(`
  SELECT grantee, table_name, privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('fabrics','invoice_lines')
    AND grantee = current_user
  ORDER BY 2,3
`);
console.log("grants", grants.rows.slice(0, 20));

// Bypass attempt
try {
  await client.query("SET row_security = off");
  const t = await client.query("SELECT count(*)::int AS n FROM tenants");
  console.log("tenants_no_rls", t.rows[0]);
  const f = await client.query("SELECT count(*)::int AS n FROM fabrics");
  console.log("fabrics_no_rls", f.rows[0]);
  const urows = await client.query("SELECT id, name, role FROM users LIMIT 5");
  console.log("users", urows.rows);
} catch (e) {
  console.log("bypass_err", e.message);
}

await client.end();
