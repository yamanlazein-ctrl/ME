// One-time fix script: ensure admin@erp.local / admin123 exists
// Idempotent — safe to run multiple times.
//
// Reason: the original `src/scripts/seed.ts` has a bug
// (`if (!tenant)` on a destructured array from `.returning()`
// is always false for an empty array, so the user-insert step
// runs with `tenantId = undefined` and silently fails when the
// "default" tenant already exists). This script does the job
// the seed was supposed to do.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import argon2 from "@node-rs/argon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
const envContent = readFileSync(envPath, "utf-8");
const env = Object.fromEntries(
  envContent
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      return [k, v];
    }),
);

const DATABASE_URL =
  env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/erp";
const EMAIL = "admin@erp.local";
const PASSWORD = "admin123";
const TENANT_SLUG = "default";
const TENANT_NAME = "Default Tenant";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
console.log("connected:", DATABASE_URL.replace(/:[^:@]+@/, ":***@"));

try {
  // 1. Find or create the "default" tenant.
  const { rows: existingTenants } = await client.query(
    "SELECT id, name, slug FROM tenants WHERE slug = $1 LIMIT 1",
    [TENANT_SLUG],
  );
  let tenantId;
  if (existingTenants.length > 0) {
    tenantId = existingTenants[0].id;
    console.log(`tenant '${TENANT_SLUG}' exists: ${tenantId}`);
  } else {
    const { rows } = await client.query(
      "INSERT INTO tenants (name, slug, status, max_users) VALUES ($1, $2, 'active', 10) RETURNING id",
      [TENANT_NAME, TENANT_SLUG],
    );
    tenantId = rows[0].id;
    console.log(`tenant '${TENANT_SLUG}' CREATED: ${tenantId}`);
  }

  // 2. Find or create the admin@erp.local user.
  const { rows: existingUsers } = await client.query(
    "SELECT id, email, role, active, password_hash FROM users WHERE email = $1 AND tenant_id = $2 LIMIT 1",
    [EMAIL, tenantId],
  );
  if (existingUsers.length > 0) {
    console.log(`user '${EMAIL}' exists: ${existingUsers[0].id} role=${existingUsers[0].role} active=${existingUsers[0].active}`);
    console.log("(idempotent — no changes)");
  } else {
    const passwordHash = await argon2.hash(PASSWORD, {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      algorithm: 2, // Argon2id
    });
    const { rows } = await client.query(
      "INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES ($1, $2, $3, $4, 'admin', true) RETURNING id",
      [tenantId, "مدير النظام", EMAIL, passwordHash],
    );
    console.log(`user '${EMAIL}' CREATED: ${rows[0].id}`);
  }

  console.log("\nDONE. You can now log in with:");
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  (the frontend will auto-fill the right tenant)`);
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
