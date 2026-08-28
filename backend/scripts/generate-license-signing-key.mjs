#!/usr/bin/env node
/**
 * Generate a PERSISTENT Ed25519 license signing keypair.
 *
 * Why this exists
 * ---------------
 * Offline license tokens are signed with EdDSA. When `LICENSE_SIGNING_KEY` is
 * unset, the backend and the license server each generate an ephemeral keypair
 * at boot — so every restart silently invalidates every token issued before
 * it, and an offline client that was activated yesterday can no longer be
 * verified. The key must be created ONCE and persisted.
 *
 * Usage
 * -----
 *   node scripts/generate-license-signing-key.mjs            # print to stdout
 *   node scripts/generate-license-signing-key.mjs --write    # append to backend/.env
 *
 * `--write` refuses to overwrite an existing LICENSE_SIGNING_KEY: rotating the
 * key invalidates all issued tokens, so that has to be a deliberate manual act.
 *
 * The value is stored with escaped newlines (`\n`) on a single line, which
 * dotenv and the process environment both round-trip safely; the signer
 * restores real newlines via `normalizePem`.
 */
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");

const { privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
const pubPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();

const oneLine = (pem) => pem.replace(/\n/g, "\\n");

const block = [
  "",
  "# ── License signing keypair (Ed25519) — generated once, DO NOT regenerate ──",
  "# Rotating these invalidates every offline license token already issued.",
  `LICENSE_SIGNING_KEY="${oneLine(privPem)}"`,
  `LICENSE_SIGNING_PUBLIC_KEY="${oneLine(pubPem)}"`,
  "",
].join("\n");

const wantsWrite = process.argv.includes("--write");

if (!wantsWrite) {
  process.stdout.write(block + "\n");
  process.stdout.write(
    "# Not written. Re-run with --write to append to backend/.env, " +
      "or copy the two lines above yourself.\n",
  );
  process.exit(0);
}

if (existsSync(envPath)) {
  const current = readFileSync(envPath, "utf8");
  if (/^\s*LICENSE_SIGNING_KEY\s*=/m.test(current)) {
    console.error(
      "Refusing to write: backend/.env already defines LICENSE_SIGNING_KEY.\n" +
        "Rotating the signing key invalidates all issued offline tokens — " +
        "remove the existing line by hand if that is genuinely what you want.",
    );
    process.exit(1);
  }
}

appendFileSync(envPath, block, "utf8");
console.log(`Appended a persistent license signing keypair to ${envPath}`);
console.log("Restart the backend and the license server to pick it up.");
