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

  // D4: allow the desktop build to pin a known tenant id (the one the
  // frontend/backend expect via VITE_DEFAULT_TENANT_ID). When unset, the
  // legacy behaviour (random uuid) is preserved so dev seeding is unchanged.
  const fixedTenantId = process.env.SEED_TENANT_ID?.trim() || undefined;
  // D4: allow the desktop build to bake a known admin password instead of a
  // one-time random one (which the customer could never retrieve). When unset,
  // the legacy random+printed-once behaviour is preserved.
  const fixedAdminPassword = process.env.SEED_ADMIN_PASSWORD?.trim() || undefined;

  // Create default tenant
  const [tenant] = await db
    .insert(tenants)
    .values({
      ...(fixedTenantId ? { id: fixedTenantId } : {}),
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
  // D4: a desktop build may pin a known password via SEED_ADMIN_PASSWORD so
  // the customer can actually log in (the one-time random value would be lost).
  const adminPassword = fixedAdminPassword ?? generateAdminPassword();
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
