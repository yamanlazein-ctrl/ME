/**
 * DFP-038 — refresh token lifetime + revocation controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const THIRTY_DAYS_MS = 2_592_000_000;

describe("DFP-038 refresh token policy", () => {
  it("default REFRESH_TOKEN_EXPIRY_MS is 30 days (not 365)", () => {
    const src = readFileSync(resolve(here, "../src/infrastructure/config/env.ts"), "utf8");
    expect(src).toMatch(/REFRESH_TOKEN_EXPIRY_MS:\s*z\.coerce\.number\(\)\.default\(2_592_000_000\)/);
    expect(src).toMatch(/30 days/);
    expect(src).not.toMatch(/default\(31_536_000_000\)/); // 365d
    expect(THIRTY_DAYS_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("auth route rotates refresh via denylist and revokes on logout", () => {
    const src = readFileSync(resolve(here, "../src/presentation/routes/auth.route.ts"), "utf8");
    expect(src).toMatch(/reason:\s*"rotated"/);
    expect(src).toMatch(/tokenDenylist\.add\(payload\.jti/);
    expect(src).toMatch(/\/api\/auth\/logout/);
  });
});
