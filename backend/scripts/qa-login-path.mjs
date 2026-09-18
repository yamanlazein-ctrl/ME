import "dotenv/config";
import { hash, verify } from "@node-rs/argon2";
import pg from "pg";

// Direct replication of login path against the same DB URL the server uses.
const DATABASE_URL = process.env.DATABASE_URL;
const tenantId = "d9b59c10-1875-4cfd-8da7-1fea2c4944fd";
const email = "firstrun.admin+1789646561009@erp.test";
const password = "admin123";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
  await client.query("SELECT set_config('app.platform_mode', $1, false)", [null]);
  const r = await client.query(
    `SELECT id, email, active, password_hash, pin_hash FROM users WHERE email = $1 AND tenant_id = $2 LIMIT 1`,
    [email, tenantId],
  );
  console.log("found", r.rowCount, r.rows[0]?.id);
  if (r.rows[0]) {
    console.log("verify", await verify(r.rows[0].password_hash, password));
  }

  // Also check DESKTOP and default slug
  await client.query("SELECT set_config('app.platform_mode', $1, false)", ["on"]);
  const t = await client.query(`SELECT id, slug FROM tenants`);
  console.log("tenants", t.rows);
} finally {
  client.release();
  await pool.end();
}

// Check LoginSchema if shared package transforms email
try {
  const mod = await import("../src/presentation/routes/auth.schema.ts");
  console.log("schema keys", Object.keys(mod));
} catch (e) {
  console.log("schema import", e.message);
}
