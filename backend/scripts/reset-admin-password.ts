import { db } from "../src/infrastructure/orm/drizzle.js";
import { users } from "../src/infrastructure/orm/schemas/user.table.js";
import { Argon2PasswordHasher } from "../src/infrastructure/auth/PasswordHasher.js";
import { eq } from "drizzle-orm";

async function main() {
  const hasher = new Argon2PasswordHasher();
  const hash = await hasher.hash("admin123");
  const result = await db
    .update(users)
    .set({ passwordHash: hash })
    .where(eq(users.email, "admin@erp.local"))
    .returning({ id: users.id, email: users.email });
  console.log("Password reset for:", JSON.stringify(result));
  console.log("Email: admin@erp.local");
  console.log("Password: admin123");
  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
