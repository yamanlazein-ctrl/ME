import { z } from "zod";
import dotenv from "dotenv";

// A DATABASE_URL set by the launching process (not by a .env file) is captured
// first: under DB_ENGINE=sqlite it is a fatal misconfiguration, while one that
// only comes from a developer .env file is dropped (no PostgreSQL path may run).
const explicitDatabaseUrl = process.env.DATABASE_URL;

// Load env from backend/.env first, then project root .env
dotenv.config({ path: ".env" });
dotenv.config({ path: "../.env" });

if (process.env.DB_ENGINE === "sqlite" && explicitDatabaseUrl === undefined) {
  delete process.env.DATABASE_URL;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Desktop packaging mode: the backend is launched by the Tauri sidecar on a
  // single self-contained machine. Relaxes three production boot gates that
  // assume a server operator is present to provision secrets (see gates below).
  // Does NOT relax APP_MASTER_KEY, JWT_SECRET, DATABASE_URL, CORS, or any
  // auth/RLS hardening — those still fail closed.
  DESKTOP_DEPLOY: z.coerce.boolean().default(false),
  // Offline number blocks (per-device pre-reserved ranges of document numbers).
  // OFF by default: every document number then comes from the single tenant
  // counter inside the save transaction, so numbering is gapless (0001, 0002…).
  // Turn ON only for multi-device OFFLINE deployments — reserving blocks jumps the
  // shared counter by the block size per device (e.g. ENT-2026-0001 → 0602).
  // Parsed explicitly: z.coerce.boolean() would read the string "false" as true.
  NUMBER_BLOCKS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Web/server deployment. The desktop does NOT use this: Phase 1 moved the
  // bundled sidecar onto a named pipe, so the shipped client has no HTTP port.
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  // Desktop: absolute path of the built single-page frontend. When set, this process serves it on the same
  // origin as the API (no SSR server, no proxy, no second port). Unset for the web deployment.
  SERVE_STATIC_DIR: z.string().optional(),
  // Desktop: Windows named pipe the server listens on INSTEAD of a TCP port.
  // The UI is served by the Tauri shell over its own asset protocol, so the
  // API never needs an open port: Rust talks to this pipe directly, and a
  // dead sidecar becomes a typed error instead of a browser error page.
  // Unset for the web deployment, which keeps the PORT/HOST behaviour below.
  DESKTOP_PIPE: z.string().optional(),
  // Desktop sidecars must bind loopback. Server installs may use 0.0.0.0 but
  // then DFP-030 forbids loopback auth bypass (see license-server.ts).
  HOST: z.string().default(process.env.DESKTOP_DEPLOY === "true" || process.env.DESKTOP_DEPLOY === "1" ? "127.0.0.1" : "0.0.0.0"),
  // Database engine (specs/001-desktop-sqlite-engine, contracts/db-engine-port.md):
  // `postgres` (default; cloud and today's desktop) requires DATABASE_URL;
  // `sqlite` (desktop, set by the Tauri runtime) requires SQLITE_PATH and
  // forbids DATABASE_URL. Either violation is fatal — never a fallback.
  DB_ENGINE: z.enum(["postgres", "sqlite"]).default("postgres"),
  DATABASE_URL: z.string().url().optional(),
  // Desktop SQLite: absolute path of the company database file.
  SQLITE_PATH: z.string().optional(),
  // Desktop SQLite: device-binding installation id passed by the runtime.
  MOTARD_INSTALLATION_ID: z.string().optional(),
  // Desktop SQLite: expected `motard_meta.data_id`; the backend refuses to serve on mismatch.
  MOTARD_DATA_ID: z.string().optional(),
  // Desktop SQLite: startup state decided by the runtime (contracts/data-root-and-startup-states.md).
  // Only `FRESH` may create the database file; anything else opens an existing file or fails.
  MOTARD_STARTUP_STATE: z.enum(["FRESH", "REUSE", "OPEN_EXISTING"]).optional(),
  // Desktop SQLite: install-instance GUID (HKCU marker, decision D-1), recorded when the file is created.
  MOTARD_INSTALL_INSTANCE_ID: z.string().optional(),
  REDIS_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32),
  // Desktop SKU: the workshop signs in once and stays signed in. An access
  // token that expires on a timer logged the operator out of an unattended
  // kiosk every 30 minutes, which is the "it signs me out on its own" report.
  // One year (with an override for server deployments) is long enough to
  // outlive any realistic idle period; logout and refresh rejection remain
  // the only ways a stored session ends.
  JWT_EXPIRY_MS: z.coerce.number().default(31_536_000_000), // 365 days
  // Must not be shorter than JWT_EXPIRY_MS, or the refresh token becomes the
  // real ceiling and the access-token life above buys nothing.
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
}).superRefine((env, ctx) => {
  if (env.DB_ENGINE === "postgres" && !env.DATABASE_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "DATABASE_URL is required when DB_ENGINE=postgres" });
  }
  if (env.DB_ENGINE === "sqlite") {
    if (!env.SQLITE_PATH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SQLITE_PATH"], message: "SQLITE_PATH is required when DB_ENGINE=sqlite" });
    }
    if (env.DATABASE_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "DATABASE_URL must not be set when DB_ENGINE=sqlite" });
    }
  }
});

const parsedEnv = envSchema.parse(process.env);
// DATABASE_URL stays typed as `string` so the PostgreSQL call sites are unchanged.
// It is empty only for DB_ENGINE=sqlite, where no PostgreSQL code path may run.
export const config = { ...parsedEnv, DATABASE_URL: parsedEnv.DATABASE_URL ?? "" };
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
