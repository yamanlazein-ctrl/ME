/**
 * D4-2 (option d): bake a pre-signed desktop license into the bundled DB.
 *
 * Runs on the DEV machine (which has LICENSE_SIGNING_KEY). Signs an offline
 * token with ~100y validity, inserts a `licenses` row bound to the default
 * tenant, and stores the signed token in `licenses.offline_token`. The runtime
 * (DESKTOP_DEPLOY) reads this via bootstrapDesktopLicenseUseCase and migrates
 * it into the encrypted `secrets` store — no private key is ever shipped.
 *
 * If LICENSE_SIGNING_KEY / LICENSE_SIGNING_PUBLIC_KEY are absent, an ephemeral
 * Ed25519 keypair is generated for the run (useful for local testing; the
 * public JWK is printed so the token can be verified). For production, set both
 * env vars to your real license-signing keypair PEMs.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres@localhost:5432/erp_bake \
 *   [LICENSE_SIGNING_KEY=... LICENSE_SIGNING_PUBLIC_KEY=...] \
 *   npx tsx src/scripts/bake-desktop-license.ts
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../infrastructure/orm/drizzle.js";
import { licenses } from "../infrastructure/orm/schemas/license.table.js";
import { LicenseTokenSigner } from "../infrastructure/auth/LicenseTokenSigner.js";
import { FEATURES } from "../domain/licensing/features.js";
import { runWithPlatformContext } from "../infrastructure/orm/tenant-context.js";

const DEFAULT_TENANT = process.env.SEED_TENANT_ID?.trim();
if (!DEFAULT_TENANT) {
  throw new Error("SEED_TENANT_ID is required; refuse to bake a license for an implicit tenant");
}
const REQUIRED_TENANT_ID: string = DEFAULT_TENANT;
const BAKED_KEY =
  process.env.BAKED_LICENSE_KEY ?? `LIC-DESKTOP-${randomBytes(8).toString("hex").toUpperCase()}`;
// ~100 years. The runtime guard reads only the signature + this `exp`, never the
// machine fingerprint, so a long validity is what lets the desktop SKU avoid any
// runtime re-signing (there is no private key on the customer machine).
const EXPIRES_IN_SEC = 100 * 365 * 86400;

// Per-customer device cap. Defaults to 1 (single-device SKU) so existing build
// pipelines that do not set this env var keep producing a 1-device license —
// raising it at bake time licenses more concurrent devices on the same tenant
// (e.g. BAKED_LICENSE_DEVICES=2 for a manager + accountant on separate machines).
// Applied to BOTH `maxDevices` (denormalised row column, used as a fallback by
// the license provider) and `limits.devices` (the JSONB value the runtime
// `isWithinLimit(..., "devices", ...)` gate actually compares against).
const BAKED_LICENSE_DEVICES = Number(process.env.BAKED_LICENSE_DEVICES ?? 1);
if (!Number.isInteger(BAKED_LICENSE_DEVICES) || BAKED_LICENSE_DEVICES < 1) {
  throw new Error(
    `BAKED_LICENSE_DEVICES must be a positive integer (got "${process.env.BAKED_LICENSE_DEVICES}")`,
  );
}

async function main() {
  // 1. Signer: real keypair from env, or ephemeral for testing.
  let signer: LicenseTokenSigner;
  const priv = process.env.LICENSE_SIGNING_KEY?.trim();
  const pub = process.env.LICENSE_SIGNING_PUBLIC_KEY?.trim();
  if (priv && pub) {
    signer = LicenseTokenSigner.fromPems(priv, pub);
    console.log("[bake] using provided LICENSE_SIGNING_KEY (production mode)");
  } else {
    const kp = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(kp.publicJwk, kp.privateJwk);
    console.log("[bake] no LICENSE_SIGNING_KEY set — generated EPHEMERAL keypair for this run");
    console.log("[bake] ephemeral PUBLIC JWK (verify with this):\n" + JSON.stringify(kp.publicJwk));
  }

  // 2. Insert (or reuse) the license row under platform RLS context.
  const row = await runWithPlatformContext(async () => {
    const [existing] = await db
      .select()
      .from(licenses)
      .where(eq(licenses.key, BAKED_KEY))
      .limit(1);
    if (existing) {
      console.log(`[bake] license key already exists id=${existing.id} — re-baking token`);
      return existing;
    }
    const [created] = await db
      .insert(licenses)
      .values({
        key: BAKED_KEY,
        type: "full",
        status: "active",
        expiresAt: null,
        graceDays: 7,
        maxDevices: BAKED_LICENSE_DEVICES,
        features: [
          FEATURES.INVENTORY,
          FEATURES.ACCOUNTING,
          FEATURES.REPORTS,
          FEATURES.SALES,
          FEATURES.PURCHASING,
        ],
        customerName: "Desktop Baked License",
        edition: "enterprise",
        plan: "standard",
        licenseVersion: "v1",
        productVersion: "1.0.0",
        licenseModel: "perpetual",
        bindingType: "none",
        bindingValue: null,
        tenantId: DEFAULT_TENANT as never,
        limits: {
          users: 999,
          devices: BAKED_LICENSE_DEVICES,
          branches: 1,
          warehouses: 1,
          storage_gb: 0,
          api_calls: 0,
        },
      })
      .returning();
    console.log(`[bake] inserted licenses row id=${created.id} key=${created.key}`);
    return created;
  });

  // 3. Sign the offline token (verify-only at runtime — never re-signed).
  const iat = Math.floor(Date.now() / 1000);
  const expiresAt = iat + EXPIRES_IN_SEC;
  const jti = randomBytes(16).toString("hex");
  const token = await signer.sign(
    {
      licenseId: row.id as string,
      tenantId: REQUIRED_TENANT_ID,
      features: row.features as string[],
      expiresAt,
      serverFingerprint: "desktop-pre-baked",
      edition: row.edition ?? "enterprise",
      plan: row.plan ?? "standard",
      licenseVersion: row.licenseVersion ?? "v1",
      productVersion: row.productVersion ?? "1.0.0",
      licenseModel: (row.licenseModel as never) ?? "perpetual",
      bindingType: (row.bindingType as never) ?? "none",
      bindingValue: (row.bindingValue as never) ?? "desktop-pre-baked",
      limits: (row.limits as never) ?? {},
      transferPolicy: (row.transferPolicy as never) ?? {
        allowed: false,
        max_transfers: 0,
        requires_super_admin: true,
      },
      updatePolicy: (row.updatePolicy as never) ?? {
        channel: "stable",
        allow_updates: true,
        minimum_version: "1.0.0",
      },
      backupPolicy: (row.backupPolicy as never) ?? {
        enabled: true,
        cloud_backup: false,
        max_backups: 30,
      },
    },
    { expiresInSec: EXPIRES_IN_SEC, jti },
  );

  // 4. Persist the signed token on the row (unencrypted; signed JWT is
  //    integrity-protected, not secret — the runtime migrates it encrypted).
  await runWithPlatformContext(async () => {
    await db
      .update(licenses)
      .set({ offlineToken: token, offlineTokenJti: jti, status: "active" })
      .where(eq(licenses.id, row.id));
  });
  console.log("[bake] wrote offline_token + offline_token_jti onto the row");

  // 5. Self-verify with the public key (no private key needed) + assert validity.
  const v = await signer.verify(token);
  const diff = v.exp - v.iat;
  console.log(
    `[bake] verify OK. exp(${v.exp}) - iat(${v.iat}) = ${diff} sec = ${Math.round(diff / 86400)} days`,
  );
  if (diff !== EXPIRES_IN_SEC) {
    throw new Error(`[bake] exp-iat (${diff}) != expected ${EXPIRES_IN_SEC} — validity mismatch`);
  }
  console.log(`[bake] OK: token validity matches ~100 years (${EXPIRES_IN_SEC} sec)`);

  // 6. Read back the row to confirm persistence of both columns.
  const stored = await runWithPlatformContext(async () => {
    const [r] = await db
      .select({
        key: licenses.key,
        off: licenses.offlineToken,
        jti: licenses.offlineTokenJti,
      })
      .from(licenses)
      .where(eq(licenses.id, row.id));
    return r;
  });
  console.log(
    `[bake] stored: key=${stored?.key}, offline_token.length=${stored?.off?.length}, jti=${stored?.jti}`,
  );
  if (!stored?.off || !stored?.jti) {
    throw new Error("[bake] offline_token / offline_token_jti were NOT persisted");
  }

  console.log("[bake] DONE — license baked successfully");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
