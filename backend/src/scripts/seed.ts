import { randomBytes } from "node:crypto";
import { db } from "../infrastructure/orm/drizzle.js";
import { tenants } from "../infrastructure/orm/schemas/tenant.table.js";
import { users } from "../infrastructure/orm/schemas/user.table.js";
import { Argon2PasswordHasher } from "../infrastructure/auth/PasswordHasher.js";

/**
 * Generate a cryptographically-strong random admin password.
 *
 * Security: the plaintext is printed ONCE to the console at seed time and
 * is NEVER stored anywhere in source, config, or the database. Only the
 * Argon2 hash is persisted. If the operator loses the printed password,
 * they must reset it out-of-band (or restore from backup) — there is no
 * hardcoded fallback.
 */
function generateAdminPassword(): string {
  // 18 chars, base62 alphabet (~107 bits of entropy).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(18);
  let password = "";
  for (let i = 0; i < 18; i++) {
    password += alphabet[bytes[i] % alphabet.length];
  }
  return password;
}

async function seed() {
  const hasher = new Argon2PasswordHasher();

  // Create default tenant
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: "Default Tenant",
      slug: "default",
      status: "active",
      maxUsers: 10,
    })
    .onConflictDoNothing()
    .returning();

  if (!tenant) {
    console.log("Tenant already exists, skipping seed.");
    process.exit(0);
  }

  console.log("Created tenant:", tenant.id);

  // Create admin user.
  // Task 1.2: the password is generated at seed time (random, 107 bits)
  // and printed once. It is never committed to source. To regenerate,
  // delete the seeded rows and re-run the script — there is no default.
  const adminPassword = generateAdminPassword();
  const passwordHash = await hasher.hash(adminPassword);
  const [user] = await db
    .insert(users)
    .values({
      tenantId: tenant.id,
      name: "مدير النظام",
      email: "admin@erp.local",
      passwordHash,
      role: "admin",
      active: true,
    })
    .returning();

  console.log("Created admin user:", user.id);
  console.log("Login with: admin@erp.local /", adminPassword);
  console.log(
    "SECURITY: this password is shown ONCE and is not stored anywhere. Copy it now. " +
      "If lost, reset the admin password out-of-band.",
  );
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
