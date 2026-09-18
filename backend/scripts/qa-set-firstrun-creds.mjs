/**
 * QA-only: set FirstRun Admin password+PIN for local erp proof runs.
 * Refuses non-local / non-erp.
 */
import "dotenv/config";
import pg from "pg";
import { hash } from "@node-rs/argon2";

const app = new URL(process.env.DATABASE_URL);
if (app.pathname.replace(/^\//, "") !== "erp" || !["localhost", "127.0.0.1"].includes(app.hostname)) {
  console.error("REFUSING non-QA target");
  process.exit(2);
}
const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  `postgresql://postgres:postgres@${app.hostname}:${app.port || 5432}/erp`;

const USER_ID = "3cc49d25-9614-40f0-a61d-9f8aacc14e0d";
const PASSWORD = "admin123";
const PIN = "4829";

const c = new pg.Client({ connectionString: adminUrl });
await c.connect();
const pwHash = await hash(PASSWORD);
const pinHash = await hash(PIN);
const r = await c.query(
  `UPDATE users
   SET password_hash = $1, pin_hash = $2, active = true, updated_at = now()
   WHERE id = $3
   RETURNING id, email, name, tenant_id`,
  [pwHash, pinHash, USER_ID],
);
console.log("updated", r.rows[0]);
await c.end();
