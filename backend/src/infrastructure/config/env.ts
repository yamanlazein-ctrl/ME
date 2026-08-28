import { z } from "zod";
import dotenv from "dotenv";

// Load env from backend/.env first, then project root .env
dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY_MS: z.coerce.number().default(1_800_000), // 30 minutes
  REFRESH_TOKEN_EXPIRY_MS: z.coerce.number().default(2_592_000_000), // 30 days
  // Comma-separated allowlist. Default covers the ERP frontend (5173) and
  // the license admin dashboard (5174) in dev. Parsed into an array by
  // `corsOrigins` below; the raw string is kept for backwards compatibility.
  CORS_ORIGIN: z.string().default("http://localhost:5173,http://localhost:5174"),
  RATE_LIMIT_RPS: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
  FX_UPSTREAM_URL: z.string().url().default("https://liranews.info/api/public/v1/price/usdsypd"),
  FX_REFRESH_INTERVAL_MS: z.coerce.number().default(15 * 60 * 1000),
  FX_FETCH_TIMEOUT_MS: z.coerce.number().default(8_000),
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
if (config.NODE_ENV === "production" && !config.SETUP_TOKEN) {
  throw new Error(
    "SETUP_TOKEN must be set when NODE_ENV=production — refusing to start with the setup wizard unauthenticated.",
  );
}
if (config.NODE_ENV === "production" && config.CORS_ORIGIN.trim() === "*") {
  throw new Error("CORS_ORIGIN=* is not allowed in production — set an explicit allowlist.");
}
if (config.NODE_ENV === "production" && !config.REDIS_URL) {
  throw new Error(
    "REDIS_URL must be set when NODE_ENV=production — token denylist requires Redis.",
  );
}
