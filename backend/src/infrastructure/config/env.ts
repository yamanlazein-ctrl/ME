import { z } from "zod";
import dotenv from "dotenv";

// Load env from backend/.env first, then project root .env
dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Desktop packaging mode: the backend is launched by the Tauri sidecar on a
  // single self-contained machine. Relaxes three production boot gates that
  // assume a server operator is present to provision secrets (see gates below).
  // Does NOT relax APP_MASTER_KEY, JWT_SECRET, DATABASE_URL, CORS, or any
  // auth/RLS hardening — those still fail closed.
  DESKTOP_DEPLOY: z.coerce.boolean().default(false),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY_MS: z.coerce.number().default(1_800_000), // 30 minutes
  // Desktop SKU keeps the operator signed in across reboots until explicit
  // logout; 365 days avoids a silent cliff after a month of daily use.
  REFRESH_TOKEN_EXPIRY_MS: z.coerce.number().default(31_536_000_000), // 365 days
  // Comma-separated allowlist. Default covers Vite (5173), SSR sidecar (4173),
  // and the license admin dashboard (5174) on both localhost and 127.0.0.1 —
  // browsers treat those as different origins (local web test on :4173 was
  // blocked and fell through to the license-key wizard).
  CORS_ORIGIN: z
    .string()
    .default(
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:5174,http://127.0.0.1:5174",
    ),
  RATE_LIMIT_RPS: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Optional logs directory. Absolute or relative to the project root
  // (backend/src/infrastructure/config/logger.ts resolves `../..` x4 up).
  // Default: "logs" → <repo-root>/logs.
  LOG_DIR: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
  // -- Secrets: master key for AES-256-GCM secret encryption (Task 1.1) --
  // 32 bytes, base64. Missing/invalid causes the app to refuse to boot.
  APP_MASTER_KEY: z.string(),
  // -- Setup / license bootstrap --
  SETUP_TOKEN: z.string().optional(),
  // ── License server (self-hosted) ──
  LICENSE_SIGNING_KEY: z.string().optional(),
  LICENSE_SIGNING_PUBLIC_KEY: z.string().optional(),
  LICENSE_SERVER_MODE: z.enum(["server", "embedded"]).default("embedded"),
  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),
  // ── FX reference rate (header display-only widget — never billing logic) ──
  FX_UPSTREAM_URL: z
    .string()
    .url()
    .default("https://lirascope.syria-cloud.sy/api/v1/rates/latest?currencies=USD&lang=ar"),
  FX_REFRESH_INTERVAL_MS: z.coerce.number().default(15 * 60 * 1000),
  FX_FETCH_TIMEOUT_MS: z.coerce.number().default(8_000),
  // Optional central sync hub URL for desktop peers (phase 4+). Empty = local-only.
  CENTRAL_SYNC_URL: z.string().url().optional(),
});

export const config = envSchema.parse(process.env);
export type Config = typeof config;

/**
 * CORS_ORIGIN parsed into a list.
 *
 * Defence-in-depth companion to the dashboard's proxy-based (same-origin)
 * calls: a direct API call that bypasses the proxy — a manual test, a
 * script, a differently-hosted dashboard — still gets a correct CORS
 * response instead of failing opaquely. `"*"` is passed through unchanged
 * (and is already refused in production by the check below).
 */
export const corsOrigins: string[] | "*" =
  config.CORS_ORIGIN.trim() === "*"
    ? "*"
    : config.CORS_ORIGIN.split(",")
        .map((o) => o.trim())
        .filter(Boolean);

// Fix C-3 (forensic audit 2026-08-15): the setup-wizard token gate was
// documented as "validated at container startup" but nothing ever enforced
// that. In production with SETUP_TOKEN unset, the wizard endpoints accept
// any caller. Fail closed at boot instead of silently opening the wizard.
// In DESKTOP_DEPLOY mode the customer runs the wizard locally on first launch
// (see setup.route.ts + install.gate.middleware.ts), so the SETUP_TOKEN gate
// is relaxed — but only until the wizard marks the install completed, after
// which the install gate and assertWizardMutable lock it permanently.
if (
  config.NODE_ENV === "production" &&
  !config.DESKTOP_DEPLOY &&
  !config.SETUP_TOKEN
) {
  throw new Error(
    "SETUP_TOKEN must be set when NODE_ENV=production — refusing to start with the setup wizard unauthenticated.",
  );
}
if (config.NODE_ENV === "production" && config.CORS_ORIGIN.trim() === "*") {
  throw new Error("CORS_ORIGIN=* is not allowed in production — set an explicit allowlist.");
}
// Server deployments require Redis for the denylist fast path. DESKTOP_DEPLOY is
// exempt because it ships its own PostgreSQL and no Redis — since P0-004 the
// denylist is DB-backed (`revoked_tokens`), so revocation is enforced there too
// and Redis is an optimisation, never a requirement (see TokenDenylist.ts).
if (
  config.NODE_ENV === "production" &&
  !config.DESKTOP_DEPLOY &&
  !config.REDIS_URL
) {
  throw new Error(
    "REDIS_URL must be set when NODE_ENV=production — token denylist requires Redis.",
  );
}
// An unset signing key makes both entrypoints mint an EPHEMERAL keypair at
// boot, so every restart silently invalidates every offline license token
// issued before it. Fail closed rather than ship a build whose licenses
// expire on the next restart. Generate one with `npm run license:genkey`.
// Verify-only installs (public key without the private key) are allowed:
// they cannot sign, and the tokens they verify were signed elsewhere. The
// DESKTOP_DEPLOY path is intentionally verify-only (D3): the private key is
// never shipped, so the public key alone is sufficient to boot.
if (
  config.NODE_ENV === "production" &&
  !config.LICENSE_SIGNING_KEY &&
  !config.LICENSE_SIGNING_PUBLIC_KEY
) {
  throw new Error(
    "LICENSE_SIGNING_KEY must be set when NODE_ENV=production — refusing to start with an " +
      "ephemeral license signing key, which would invalidate every issued offline token on " +
      "each restart. Generate a persistent keypair with: npm run license:genkey",
  );
}
