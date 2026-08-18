import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { PostgresSystemAdminRepository } from "../../../infrastructure/repositories/PostgresSystemAdminRepository.js";
import type { Argon2PasswordHasher } from "../../../infrastructure/auth/PasswordHasher.js";
import type { JwtSigner } from "../../../infrastructure/auth/JwtSigner.js";
import type { RedisTokenDenylist } from "../../../infrastructure/auth/TokenDenylist.js";

/**
 * Phase 4 — Super Admin authentication (frozen spec §2.1).
 *
 * Authenticates a system-level Super Admin against `system_admins` and
 * issues a JWT (role = "super_admin") usable against /license-admin/*.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function superAdminLoginUseCase(
  repo: PostgresSystemAdminRepository,
  hasher: Argon2PasswordHasher,
  jwtSigner: JwtSigner,
  denylist: RedisTokenDenylist,
  input: unknown,
): Promise<Result<{ token: string; admin: { id: string; email: string; name: string | null; role: string } }>> {
  const parsed = loginInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "بيانات الدخول غير صالحة" };
  }
  const admin = await repo.findByEmail(parsed.data.email);
  if (!admin) {
    return { ok: false, error: "بيانات الدخول غير صالحة" };
  }
  const ok = await hasher.verify(admin.passwordHash, parsed.data.password);
  if (!ok) {
    return { ok: false, error: "بيانات الدخول غير صالحة" };
  }
  const token = await jwtSigner.signAccessToken({
    sub: admin.id,
    tenantId: "system",
    role: admin.role,
    jti: randomUUID(),
  });
  return {
    ok: true,
    data: { token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } },
  };
}
