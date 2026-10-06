/**
 * DFP-038 — refresh token default is 365 days and logout/refresh paths
 * denylist JTIs so long sessions cannot bypass revocation.
 *
 * LIFETIME (updated 2026-09-28): was 30 days, now 365 — see the sibling file
 * `dfp038-refresh-policy.test.ts` for why (the desktop kiosk must not sign the
 * operator out on a timer). This file previously asserted 30 days AND forbade
 * 365, which contradicted the product requirement; it now pins 365.
 *
 * The revocation half of DFP-038 is unchanged and still asserted below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// env.ts writes it with underscore separators, so match either spelling.
const ONE_YEAR_LITERAL = "31_536_000_000|31536000000";

describe("DFP-038 refresh token policy", () => {
  it("default REFRESH_TOKEN_EXPIRY_MS is 365 days", () => {
    const src = readFileSync(resolve(here, "../src/infrastructure/config/env.ts"), "utf8");
    expect(src).toMatch(
      new RegExp(
        `REFRESH_TOKEN_EXPIRY_MS:\\s*z\\.coerce\\.number\\(\\)\\.default\\((${ONE_YEAR_LITERAL})\\)`,
      ),
    );
  });

  it("auth logout and refresh rotate via tokenDenylist", () => {
    const auth = readFileSync(resolve(here, "../src/presentation/routes/auth.route.ts"), "utf8");
    expect(auth).toMatch(/tokenDenylist\.add/);
    expect(auth).toMatch(/tokenDenylist\.has/);
  });
});
