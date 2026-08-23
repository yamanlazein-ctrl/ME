import pg from "pg";
import { randomBytes, scrypt as _scrypt } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(_scrypt);

// Which hasher does the backend use? Argon2 (@node-rs/argon2). Hash admin123
// with the same algorithm/params via @node-rs/argon2 directly.
import { hash } from "@node-rs/argon2";

const c = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/erp_test" });
await c.connect();

const t = await c.query("select id from tenants order by created_at limit 1");
const tenantId = t.rows[0].id;
console.log("Seeding admin into tenant:", tenantId);

const passwordHash = await hash("admin123");

await c.query(
  `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
   VALUES ($1, 'Admin', 'admin@erp.local', $2, 'admin', true)
   ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
  [tenantId, passwordHash]
);
console.log("admin@erp.local / admin123 seeded.");
await c.end();
