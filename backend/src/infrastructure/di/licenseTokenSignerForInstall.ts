/**
 * Licence token signer for a customer install — moved verbatim from container.ts so both engine
 * wirings (postgresContainer.ts, sqliteContainer.ts) share it (specs/001-desktop-sqlite-engine).
 */
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { LicenseTokenSigner } from "../auth/LicenseTokenSigner.js";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

/**
 * Build the license token signer for a customer install.
 *
 * - When `LICENSE_SIGNING_KEY` is set (self-hosted single process), both
 *   sign + verify work (PEM form). `LICENSE_SIGNING_PUBLIC_KEY` is optional:
 *   the public key is derived from the private key when absent.
 * - When only the PUBLIC key is set (separate License Server), the
 *   customer install can verify but not sign.
 * - When neither is set, **auto-generate and persist** a new keypair to
 *   `backend/.env` so subsequent restarts reuse the same key (offline
 *   license tokens survive restarts). Production requires the key to be
 *   pre-set (see env.ts) — auto-persist only happens in non-production.
 */
export function buildLicenseTokenSignerForInstall(): LicenseTokenSigner {
  // `.trim()` so a blank/whitespace-only env value counts as absent rather
  // than reaching the PEM parser with nothing usable.
  if (config.LICENSE_SIGNING_KEY?.trim()) {
    return LicenseTokenSigner.fromPems(
      config.LICENSE_SIGNING_KEY,
      config.LICENSE_SIGNING_PUBLIC_KEY ?? "",
    );
  }
  if (config.LICENSE_SIGNING_PUBLIC_KEY?.trim()) {
    return LicenseTokenSigner.fromPems(null, config.LICENSE_SIGNING_PUBLIC_KEY);
  }

  // ── Auto-persist: generate a keypair, save to .env, use it ──
  // Production refuses to boot without the key (see env.ts), so we only
  // reach here in development/test. Instead of an ephemeral key (lost on
  // every restart), generate ONCE and write it to `backend/.env` so every
  // subsequent boot reuses the same persistent key. This prevents offline
  // license tokens from silently becoming invalid after a server restart.
  //
  // DESKTOP_DEPLOY hard-disables this branch: the desktop client must never
  // mint or persist a PRIVATE signing key (D3 — the private key stays only on
  // the license server). In this mode the public key alone is expected; if it
  // is absent too, env.ts has already refused to boot, so we never reach here
  // with a writable private key in a desktop install.
  if (config.DESKTOP_DEPLOY) {
    throw new Error(
      "DESKTOP_DEPLOY requires LICENSE_SIGNING_PUBLIC_KEY to be set — the desktop client " +
        "must not generate or persist a private signing key. Provide the public key only.",
    );
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const pubPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();
  const oneLine = (pem: string) => pem.replace(/\n/g, "\\n");

  // Derive backend/.env path relative to this source file.
  // container.ts lives at backend/src/infrastructure/di/, so THREE levels up
  // reach backend/ (unlike license-server.ts at backend/src/scripts/, which
  // needs only two).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", "..", "..", ".env");
  const envBlock = [
    "",
    "# ── License signing keypair (Ed25519) — auto-generated once, DO NOT regenerate ──",
    "# Rotating these invalidates every offline license token already issued.",
    `LICENSE_SIGNING_KEY="${oneLine(privPem)}"`,
    `LICENSE_SIGNING_PUBLIC_KEY="${oneLine(pubPem)}"`,
    "",
  ].join("\n");

  // Append to .env only if LICENSE_SIGNING_KEY is not already present.
  try {
    if (!existsSync(envPath) || !/^\s*LICENSE_SIGNING_KEY\s*=/m.test(readFileSync(envPath, "utf8"))) {
      appendFileSync(envPath, envBlock, "utf8");
      logger.info(
        { envPath },
        "LICENSE_SIGNING_KEY not set — generated a persistent Ed25519 keypair and appended to .env. " +
          "Future restarts will reuse this key. Production environments must define their own key explicitly.",
      );
    }
  } catch (err) {
    logger.warn({ err, envPath }, "Failed to persist LICENSE_SIGNING_KEY to .env — using in-memory key only");
  }

  // Set the keys in process.env so the rest of the boot (and any
  // sibling processes) see them immediately.
  process.env.LICENSE_SIGNING_KEY = privPem.replace(/\n/g, "\\n");
  process.env.LICENSE_SIGNING_PUBLIC_KEY = pubPem.replace(/\n/g, "\\n");

  const privJwk = privateKey.export({ format: "jwk" }) as JWK;
  const pubJwk = publicKey.export({ format: "jwk" }) as JWK;
  return new LicenseTokenSigner(privJwk, pubJwk);
}
