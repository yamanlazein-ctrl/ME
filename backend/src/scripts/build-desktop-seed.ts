/**
 * Build-time desktop seed for the SQLite engine (specs/001-desktop-sqlite-engine T077).
 *
 * The PostgreSQL desktop shipped a pre-built cluster (pgdata-template): migrations + `seed.ts`
 * (the default tenant, no users — onboarding creates the owner) + `bake-desktop-license.ts` (a
 * licence row with a pre-signed ~100-year offline token). The SQLite build ships no database;
 * the runtime creates one on FRESH. This script produces the SAME two rows as data:
 *
 *   resources/server/desktop-seed.json = { tenant: <row>, license: <row incl. offline_token> }
 *
 * The rows are built by inserting the template's exact values into a scratch database created from
 * the SQLite baseline (so every column default matches the live schema), signing the offline token
 * over the row read back (exactly as the bake script does), and exporting the stored values. FRESH
 * inserts them verbatim (orm/sqlite/runtime.ts). The private key is used here only — never shipped.
 *
 *   SEED_TENANT_ID=<uuid> LICENSE_SIGNING_KEY=… LICENSE_SIGNING_PUBLIC_KEY=… \
 *     npx tsx src/scripts/build-desktop-seed.ts --out <file> [--dev-ephemeral]
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { LicenseTokenSigner } from "../infrastructure/auth/LicenseTokenSigner.js";
import { FEATURES } from "../domain/licensing/features.js";
import { tenants } from "../infrastructure/orm/sqlite/schemas/tenant.table.js";
import { licenses } from "../infrastructure/orm/sqlite/schemas/license.table.js";
import { resolveSqliteMigrationsFolder } from "../infrastructure/orm/sqlite/runtime.js";
import { loadSqliteJournal } from "../infrastructure/orm/sqlite/schemaFingerprint.js";
import { withExactIntegers } from "../infrastructure/orm/sqlite/exactIntegers.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const OUT = arg("--out");
if (!OUT) throw new Error("--out <file> is required");
const TENANT_ID = process.env.SEED_TENANT_ID?.trim();
if (!TENANT_ID) throw new Error("SEED_TENANT_ID is required; refuse to seed an implicit tenant");
const TENANT: string = TENANT_ID;
const DEV_EPHEMERAL = process.argv.includes("--dev-ephemeral");
const BAKED_KEY = process.env.BAKED_LICENSE_KEY ?? `LIC-DESKTOP-${randomBytes(8).toString("hex").toUpperCase()}`;
const EXPIRES_IN_SEC = 100 * 365 * 86400; // same validity as bake-desktop-license.ts
const DEVICES = Number(process.env.BAKED_LICENSE_DEVICES ?? 1);
if (!Number.isInteger(DEVICES) || DEVICES < 1) throw new Error("BAKED_LICENSE_DEVICES must be a positive integer");

async function main() {
  let signer: LicenseTokenSigner;
  let publicJwk: unknown = null;
  const priv = process.env.LICENSE_SIGNING_KEY?.trim();
  const pub = process.env.LICENSE_SIGNING_PUBLIC_KEY?.trim();
  if (priv && pub) {
    signer = LicenseTokenSigner.fromPems(priv, pub);
  } else if (DEV_EPHEMERAL) {
    const kp = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(kp.publicJwk, kp.privateJwk);
    publicJwk = kp.publicJwk;
  } else {
    throw new Error("LICENSE_SIGNING_KEY and LICENSE_SIGNING_PUBLIC_KEY are required; use --dev-ephemeral only for local development");
  }

  // Scratch database from the SQLite baseline: every default is the live schema's.
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const mig = resolveSqliteMigrationsFolder();
  for (const e of loadSqliteJournal(mig).entries) raw.exec(readFileSync(join(mig, `${e.tag}.sql`), "utf8"));
  const db = drizzle(withExactIntegers(raw));

  // seed.ts (desktop: SKIP_ADMIN_SEED=true — no users)
  db.insert(tenants).values({ id: TENANT, name: "Default Tenant", slug: "default", status: "active", maxUsers: 10 }).run();

  // bake-desktop-license.ts, same values
  db.insert(licenses)
    .values({
      key: BAKED_KEY,
      type: "full",
      status: "active",
      expiresAt: null,
      graceDays: 7,
      maxDevices: DEVICES,
      features: [FEATURES.INVENTORY, FEATURES.ACCOUNTING, FEATURES.REPORTS, FEATURES.SALES, FEATURES.PURCHASING],
      customerName: "Desktop Baked License",
      edition: "enterprise",
      plan: "standard",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "none",
      bindingValue: null,
      tenantId: TENANT,
      limits: { users: 999, devices: DEVICES, branches: 1, warehouses: 1, storage_gb: 0, api_calls: 0 },
    })
    .run();
  const row = db.select().from(licenses).where(eq(licenses.key, BAKED_KEY)).get()!;

  const iat = Math.floor(Date.now() / 1000);
  const jti = randomBytes(16).toString("hex");
  const token = await signer.sign(
    {
      licenseId: row.id,
      tenantId: TENANT,
      features: row.features as string[],
      expiresAt: iat + EXPIRES_IN_SEC,
      serverFingerprint: "desktop-pre-baked",
      edition: row.edition ?? "enterprise",
      plan: row.plan ?? "standard",
      licenseVersion: row.licenseVersion ?? "v1",
      productVersion: row.productVersion ?? "1.0.0",
      licenseModel: (row.licenseModel as never) ?? "perpetual",
      bindingType: (row.bindingType as never) ?? "none",
      bindingValue: (row.bindingValue as never) ?? "desktop-pre-baked",
      limits: (row.limits as never) ?? {},
      transferPolicy: (row.transferPolicy as never) ?? { allowed: false, max_transfers: 0, requires_super_admin: true },
      updatePolicy: (row.updatePolicy as never) ?? { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: (row.backupPolicy as never) ?? { enabled: true, cloud_backup: false, max_backups: 30 },
    },
    { expiresInSec: EXPIRES_IN_SEC, jti },
  );
  db.update(licenses).set({ offlineToken: token, offlineTokenJti: jti, status: "active" }).where(eq(licenses.id, row.id)).run();
  const v = await signer.verify(token);
  if (v.exp - v.iat !== EXPIRES_IN_SEC) throw new Error("token validity mismatch");

  // Stored values, exactly as the runtime will insert them.
  const seed = {
    format: "motard-desktop-seed",
    version: 1,
    builtAt: new Date().toISOString(),
    tenant: raw.prepare("SELECT * FROM tenants WHERE id = ?").get(TENANT_ID),
    license: raw.prepare("SELECT * FROM licenses WHERE id = ?").get(row.id),
    ...(publicJwk ? { devPublicJwk: publicJwk } : {}),
  };
  raw.close();
  mkdirSync(dirname(OUT!), { recursive: true });
  writeFileSync(OUT!, JSON.stringify(seed, null, 2));
  console.log(`[desktop-seed] tenant ${TENANT_ID}, licence ${BAKED_KEY} (offline token ${token.length} chars) → ${OUT}`);
}

await main();
