#!/usr/bin/env node
/**
 * build-desktop-seed.mjs — the desktop's first-run content (specs/001-desktop-sqlite-engine T077).
 *
 * The SQLite desktop ships no database. On FRESH the server creates `<root>\data\motard.db` from
 * the bundled baseline migrations and inserts this seed verbatim: the single default tenant and
 * the pre-signed licence — exactly the content the PostgreSQL template (pgdata-template) shipped,
 * with no users (the customer's first launch runs the onboarding that creates the owner).
 *
 * Inputs (same as the retired PostgreSQL template build):
 *   - tenant id: VITE_DEFAULT_TENANT_ID in desktop/build-frontend.cmd (the SPA must agree with it)
 *   - LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY from the environment or backend/.env
 *   - optional DESKTOP_LICENSE_KEY, BAKED_LICENSE_DEVICES
 * Output: desktop/src-tauri/resources/server/desktop-seed.json (run AFTER bundle-server.mjs,
 * which rebuilds resources/server).
 *
 * Gates: the shipped resources/license-public.pem must be the pair of the signing key (or no
 * customer could verify the licence); the seed must carry exactly that tenant, a licence for it
 * with a signed offline token, and nothing else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const BACKEND_ROOT = join(REPO_ROOT, "backend");
const OUT = join(REPO_ROOT, "desktop", "src-tauri", "resources", "server", "desktop-seed.json");
const log = (m) => console.log(`[desktop-seed] ${m}`);
const fail = (m) => {
  console.error(`[desktop-seed] FAIL: ${m}`);
  process.exit(1);
};

const frontendCmd = readFileSync(join(REPO_ROOT, "desktop", "build-frontend.cmd"), "utf8");
const tenantId = /set\s+"VITE_DEFAULT_TENANT_ID=([0-9a-f-]{36})"/i.exec(frontendCmd)?.[1];
if (!tenantId) fail("could not read VITE_DEFAULT_TENANT_ID from desktop/build-frontend.cmd");

function readSigningKeys() {
  let priv = process.env.LICENSE_SIGNING_KEY?.trim();
  let pub = process.env.LICENSE_SIGNING_PUBLIC_KEY?.trim();
  if ((!priv || !pub) && existsSync(join(BACKEND_ROOT, ".env"))) {
    const env = readFileSync(join(BACKEND_ROOT, ".env"), "utf8");
    const pick = (name) => {
      const m = new RegExp(`^${name}=(.*)$`, "m").exec(env);
      return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
    };
    priv ||= pick("LICENSE_SIGNING_KEY");
    pub ||= pick("LICENSE_SIGNING_PUBLIC_KEY");
  }
  if (!priv || !pub) fail("LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY not found (env or backend/.env)");
  const nl = (s) => s.replace(/\\n/g, "\n");
  return { priv: nl(priv), pub: nl(pub) };
}
const keys = readSigningKeys();

const shippedPem = readFileSync(join(REPO_ROOT, "desktop", "src-tauri", "resources", "license-public.pem"), "utf8");
const strip = (s) => s.replace(/-----[^-]+-----|\s+/g, "");
if (strip(shippedPem) !== strip(keys.pub)) {
  fail("resources/license-public.pem does not match LICENSE_SIGNING_PUBLIC_KEY — the baked licence would not verify on the customer machine");
}
if (!existsSync(join(REPO_ROOT, "desktop", "src-tauri", "resources", "server", "server.mjs"))) {
  fail("resources/server is not built — run bundle-server.mjs first");
}

log(`tenant ${tenantId}; signing with the configured key (never printed)`);
execFileSync(process.execPath, [join(BACKEND_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/scripts/build-desktop-seed.ts", "--out", OUT], {
  cwd: BACKEND_ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    SEED_TENANT_ID: tenantId,
    LICENSE_SIGNING_KEY: keys.priv,
    LICENSE_SIGNING_PUBLIC_KEY: keys.pub,
    ...(process.env.DESKTOP_LICENSE_KEY ? { BAKED_LICENSE_KEY: process.env.DESKTOP_LICENSE_KEY } : {}),
  },
});

// Independent gate on the file that will really be packaged.
const seed = JSON.parse(readFileSync(OUT, "utf8"));
const keysOf = (o) => Object.keys(o).sort().join(",");
if (seed.format !== "motard-desktop-seed" || seed.version !== 1) fail("unexpected seed format");
if (seed.tenant?.id !== tenantId) fail(`seed tenant ${seed.tenant?.id} ≠ ${tenantId}`);
if (seed.license?.tenant_id !== tenantId) fail("the licence is not bound to the default tenant");
if (!seed.license?.offline_token || !seed.license?.offline_token_jti) fail("the licence has no signed offline token");
if (seed.license.status !== "active") fail("the licence is not active");
if (seed.devPublicJwk) fail("an ephemeral development key was used — never ship it");
if (keysOf(seed) !== keysOf({ format: 1, version: 1, builtAt: 1, tenant: 1, license: 1 })) fail(`unexpected seed sections: ${keysOf(seed)}`);
log(`OK → ${OUT} (tenant + licence ${seed.license.key}, no users)`);
