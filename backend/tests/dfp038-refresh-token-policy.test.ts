/**
 * DFP-038 — refresh token default is 30 days (not 365) and logout/refresh
 * paths denylist JTIs so long sessions cannot bypass revocation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("DFP-038 refresh token policy", () => {
  it("default REFRESH_TOKEN_EXPIRY_MS is 30 days", () => {
    const src = readFileSync(resolve(here, "../src/infrastructure/config/env.ts"), "utf8");
    expect(src).toMatch(/REFRESH_TOKEN_EXPIRY_MS:\s*z\.coerce\.number\(\)\.default\(2_592_000_000\)/);
    expect(src).not.toMatch(/31_536_000_000/); // 365 days
  });

  it("auth logout and refresh rotate via tokenDenylist", () => {
    const auth = readFileSync(resolve(here, "../src/presentation/routes/auth.route.ts"), "utf8");
    expect(auth).toMatch(/tokenDenylist\.add/);
    expect(auth).toMatch(/tokenDenylist\.has/);
  });
});
