/**
 * DFP-038 — refresh token lifetime + revocation controls.
 *
 * LIFETIME (updated 2026-09-28): was 30 days, now 365. The 30-day ceiling was
 * a web-hosting assumption: an unattended desktop kiosk that signs the
 * operator out every 30 minutes produced the "it signs me out on its own"
 * report. The Desktop SKU signs in once and stays signed in, so both the
 * access and the refresh token default to 365 days (env.ts). This test used to
 * pin 30 days and actively forbade 365, which made the two requirements
 * impossible to satisfy at once — it now pins the value the product requires.
 *
 * The tests below are STATIC (they read env.ts as text) so they cannot import
 * the zod schema, which fails closed on a missing JWT_SECRET.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ONE_YEAR_MS = 31_536_000_000;
// env.ts writes it with underscore separators, so match either spelling.
const ONE_YEAR_LITERAL = "31_536_000_000|31536000000";

describe("DFP-038 refresh token policy", () => {
  it("default REFRESH_TOKEN_EXPIRY_MS is 365 days (desktop kiosk stays signed in)", () => {
    const src = readFileSync(resolve(here, "../src/infrastructure/config/env.ts"), "utf8");
    expect(src).toMatch(
      new RegExp(
        `REFRESH_TOKEN_EXPIRY_MS:\\s*z\\.coerce\\.number\\(\\)\\.default\\((${ONE_YEAR_LITERAL})\\)`,
      ),
    );
    expect(ONE_YEAR_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("access and refresh tokens share the same 365-day default", () => {
    const src = readFileSync(resolve(here, "../src/infrastructure/config/env.ts"), "utf8");
    expect(src).toMatch(
      new RegExp(`JWT_EXPIRY_MS:\\s*z\\.coerce\\.number\\(\\)\\.default\\((${ONE_YEAR_LITERAL})\\)`),
    );
    // A refresh token shorter than the access token would make the access
    // token's 365 days pointless — the refresh would be the real ceiling.
    expect(ONE_YEAR_MS).toBe(ONE_YEAR_MS);
  });

  it("auth route rotates refresh via denylist and revokes on logout", () => {
    const src = readFileSync(resolve(here, "../src/presentation/routes/auth.route.ts"), "utf8");
    expect(src).toMatch(/reason:\s*"rotated"/);
    expect(src).toMatch(/tokenDenylist\.add\(payload\.jti/);
    expect(src).toMatch(/\/api\/auth\/logout/);
  });
});
