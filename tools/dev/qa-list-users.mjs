import "dotenv/config";
import pg from "pg";

const app = new URL(process.env.DATABASE_URL);
const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  `postgresql://postgres:postgres@${app.hostname}:${app.port || 5432}/erp`;
const c = new pg.Client({ connectionString: adminUrl });
await c.connect();
console.log("tenants", (await c.query("SELECT id, name, slug FROM tenants")).rows);
console.log(
  "users",
  (
    await c.query(
      "SELECT id, tenant_id, name, role, email, (pin_hash IS NOT NULL) AS has_pin, (password_hash IS NOT NULL) AS has_pw FROM users",
    )
  ).rows,
);
await c.end();
