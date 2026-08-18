// Reset admin@erp.local password to "admin123" — no questions asked.
// Idempotent. Replaces the existing hash with a fresh Argon2id hash.

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
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const DATABASE_URL = env.DATABASE_URL;
const EMAIL = "admin@erp.local";
const PASSWORD = "admin123";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const { rows: existing } = await client.query(
    "SELECT id, tenant_id, password_hash FROM users WHERE email = $1 LIMIT 1",
    [EMAIL],
  );
  if (existing.length === 0) {
    console.error(`user ${EMAIL} not found`);
    process.exit(1);
  }
  const u = existing[0];
  console.log(`found: id=${u.id} tenantId=${u.tenant_id}`);
  console.log(`existing hash: ${u.password_hash.slice(0, 30)}...`);

  // Try verify with the current password.
  const ok = await argon2.verify(u.password_hash, PASSWORD);
  console.log(`verify('${PASSWORD}'): ${ok}`);

  if (!ok) {
    console.log("→ password does NOT match — resetting...");
    const newHash = await argon2.hash(PASSWORD, {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      algorithm: 2,
    });
    await client.query(
      "UPDATE users SET password_hash = $1, active = true, updated_at = now() WHERE id = $2",
      [newHash, u.id],
    );
    console.log("→ password reset DONE");

    // verify again
    const ok2 = await argon2.verify(newHash, PASSWORD);
    console.log(`verify-after-reset('${PASSWORD}'): ${ok2}`);
  } else {
    console.log("→ password already matches — no change");
  }
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
