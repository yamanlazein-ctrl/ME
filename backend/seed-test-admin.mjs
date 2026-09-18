/**
 * DFP-029 — seed a local *test* admin only.
 *
 * Refuses to run unless NODE_ENV=test or ALLOW_TEST_SEED=1.
 * Password MUST come from E2E_ADMIN_PASSWORD (no hardcoded secret).
 *
 * Usage:
 *   NODE_ENV=test E2E_ADMIN_PASSWORD='…' DATABASE_URL='…' node backend/seed-test-admin.mjs
 */
import pg from "pg";
import { hash } from "@node-rs/argon2";

if (process.env.NODE_ENV !== "test" && process.env.ALLOW_TEST_SEED !== "1") {
  console.error(
    "DFP-029: seed-test-admin.mjs refuses to run without NODE_ENV=test or ALLOW_TEST_SEED=1",
  );
  process.exit(1);
}

const password = process.env.E2E_ADMIN_PASSWORD;
if (!password || password.length < 8) {
  console.error("DFP-029: set E2E_ADMIN_PASSWORD (≥8 chars). Hardcoded passwords are forbidden.");
  process.exit(1);
}

const email = process.env.E2E_ADMIN_EMAIL ?? "admin@erp.local";
const connectionString =
  process.env.TEST_DB_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/erp_test";

const c = new pg.Client({ connectionString });
await c.connect();

const t = await c.query("select id from tenants order by created_at limit 1");
if (!t.rows[0]) {
  console.error("No tenant found — run migrations/seed first.");
  await c.end();
  process.exit(1);
}
const tenantId = t.rows[0].id;
console.log("Seeding admin into tenant:", tenantId);

const passwordHash = await hash(password);

await c.query(
  `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
   VALUES ($1, 'Admin', $2, $3, 'admin', true)
   ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
  [tenantId, email, passwordHash],
);
console.log(`${email} seeded (password from E2E_ADMIN_PASSWORD).`);
await c.end();
