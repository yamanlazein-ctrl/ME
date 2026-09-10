import { randomBytes } from "node:crypto";
import { db } from "../src/infrastructure/orm/drizzle.js";
import { users } from "../src/infrastructure/orm/schemas/user.table.js";
import { Argon2PasswordHasher } from "../src/infrastructure/auth/PasswordHasher.js";
import { eq } from "drizzle-orm";

// Reset the admin@erp.local password to a fresh strong random value.
// The password is generated in-memory, stored ONLY as an Argon2id hash in
// the database, and printed exactly once to stdout — it is never written
// to any file, log, or source file.
async function main() {
  const hasher = new Argon2PasswordHasher();
  const password = randomBytes(24).toString("base64url"); // 32 chars, ~192 bits of entropy
  const hash = await hasher.hash(password);
  const result = await db
    .update(users)
    .set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(users.email, "admin@erp.local"))
    .returning({ id: users.id, email: users.email });
  console.log("Password reset for:", JSON.stringify(result));
  console.log("Email: admin@erp.local");
  const verified = await hasher.verify(hash, password);
  console.log(`Argon2id verify(hash, new-password): ${verified ? "OK" : "FAILED"}`);
  if (!verified) {
    throw new Error("Post-reset Argon2id verification failed — aborting");
  }
  console.log("New password (shown once — store it now):");
  console.log(password);
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
