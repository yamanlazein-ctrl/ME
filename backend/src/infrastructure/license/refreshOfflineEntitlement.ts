/**
 * Phase 8 — refresh (or revoke) the signed offline entitlement after a
 * Vendor Control Plane mutation of the License SoT row.
 *
 * Safe rules:
 *  - Requires a private signing key for `resign`. Without it (desktop public-only),
 *    returns `{ ok: true, action: "skipped", reason: "NO_SIGNING_KEY" }` after
 *    still attempting revoke-side denylist when possible.
 *  - Never ships / requires a private key on DESKTOP_DEPLOY customer machines
 *    for day-to-day ERP — License Server holds the key.
 *  - Does not touch JWT user sessions, sync outbox, or DPAPI binding.
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
import { licenses } from "../orm/schemas/license.table.js";
import { licenseActivations } from "../orm/schemas/license-activation.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import { collectOfflineTokenJtisForDenylist } from "./licenseTokenJti.js";
import type {
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";
import { decideEntitlementRefreshAction } from "../../domain/licensing/licenseAuthority.js";
import { resolveDeviceLimit } from "../../domain/licensing/ownership.js";

const LICENSE_REVOCATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type EntitlementRefreshResult = {
  ok: true;
  action: "resigned" | "revoked" | "skipped" | "noop";
  reason?: string;
  newJti?: string;
};

type TokenDenylist = {
  add: (jti: string, ttlSeconds: number) => Promise<void>;
};

export type LicenseRowForRefresh = {
  id: string;
  tenantId: string | null;
  status: string;
  features: string[];
  expiresAt: Date | null;
  edition: string | null;
  plan: string | null;
  licenseVersion: string;
  productVersion: string | null;
  licenseModel: string;
  bindingType: string | null;
  bindingValue: string | null;
  limits: unknown;
  maxDevices: number;
  transferPolicy: unknown;
  updatePolicy: unknown;
  backupPolicy: unknown;
  offlineToken: string | null;
  offlineTokenJti: string | null;
};

async function denylistJtis(
  denylist: TokenDenylist | null | undefined,
  jtis: string[],
): Promise<void> {
  if (!denylist || jtis.length === 0) return;
  for (const jti of jtis) {
    await denylist.add(jti, LICENSE_REVOCATION_TTL_SECONDS);
  }
}

export async function refreshOfflineEntitlement(input: {
  db: DB;
  signer: ILicenseTokenSigner;
  license: LicenseRowForRefresh;
  secretsRepo?: ISecretsRepository | null;
  cipher?: ISecretCipher | null;
  tokenDenylist?: TokenDenylist | null;
}): Promise<EntitlementRefreshResult> {
  const { db, signer, license, secretsRepo, cipher, tokenDenylist } = input;
  const action = decideEntitlementRefreshAction(license.status);

  if (action === "noop") {
    return { ok: true, action: "noop", reason: `status=${license.status}` };
  }

  if (action === "revoke") {
    if (license.tenantId && secretsRepo && cipher) {
      const jtis = await collectOfflineTokenJtisForDenylist({
        licenseOfflineTokenJti: license.offlineTokenJti,
        licenseOfflineToken: license.offlineToken,
        tenantId: license.tenantId,
        secretsRepo,
        cipher,
        signer,
      });
      await denylistJtis(tokenDenylist, jtis);
      await secretsRepo.delete(license.tenantId, "license.token.current");
      await secretsRepo.delete(license.tenantId, "license.token.jti");
    } else {
      await denylistJtis(
        tokenDenylist,
        license.offlineTokenJti?.trim() ? [license.offlineTokenJti.trim()] : [],
      );
    }
    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ offlineToken: null, offlineTokenJti: null, updatedAt: new Date() })
        .where(eq(licenses.id, license.id as never));
    });
    return { ok: true, action: "revoked" };
  }

  // resign
  if (!signer.canSign()) {
    return { ok: true, action: "skipped", reason: "NO_SIGNING_KEY" };
  }
  if (!license.tenantId) {
    return { ok: true, action: "skipped", reason: "NO_TENANT" };
  }

  const activation = await runWithPlatformContext(async () => {
    const [row] = await db
      .select()
      .from(licenseActivations)
      .where(
        and(
          eq(licenseActivations.licenseId, license.id as never),
          isNull(licenseActivations.deactivatedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!activation) {
    return { ok: true, action: "skipped", reason: "NO_ACTIVE_ACTIVATION" };
  }

  const fingerprint = activation.serverFingerprint;
  const limits = (license.limits as LicenseLimits) ?? {
    users: 0,
    devices: resolveDeviceLimit({ maxDevices: license.maxDevices }),
    branches: 0,
    warehouses: 0,
    storage_gb: 0,
    api_calls: 0,
  };
  const newJti = randomUUID();
  const token = await signer.sign(
    {
      licenseId: license.id,
      tenantId: license.tenantId,
      features: license.features,
      expiresAt: Math.floor(
        (license.expiresAt?.getTime() ?? Date.now() + 30 * 86400000) / 1000,
      ),
      serverFingerprint: fingerprint,
      edition: license.edition ?? "",
      plan: license.plan ?? "",
      licenseVersion: license.licenseVersion,
      productVersion: license.productVersion ?? "",
      licenseModel: license.licenseModel as LicenseModel,
      bindingType: license.bindingType ?? "machine",
      bindingValue: license.bindingValue ?? fingerprint,
      limits,
      transferPolicy: (license.transferPolicy as TransferPolicy) ?? {
        allowed: true,
        max_transfers: 3,
        requires_super_admin: true,
      },
      updatePolicy: (license.updatePolicy as UpdatePolicy) ?? {
        channel: "stable",
        allow_updates: true,
        minimum_version: "1.0.0",
      },
      backupPolicy: (license.backupPolicy as BackupPolicy) ?? {
        enabled: true,
        cloud_backup: false,
        max_backups: 30,
      },
    },
    { jti: newJti },
  );

  if (license.tenantId && secretsRepo && cipher) {
    const jtis = await collectOfflineTokenJtisForDenylist({
      licenseOfflineTokenJti: license.offlineTokenJti,
      licenseOfflineToken: license.offlineToken,
      tenantId: license.tenantId,
      secretsRepo,
      cipher,
      signer,
    });
    await denylistJtis(tokenDenylist, jtis);
  } else {
    await denylistJtis(
      tokenDenylist,
      license.offlineTokenJti?.trim() ? [license.offlineTokenJti.trim()] : [],
    );
  }

  await runWithPlatformContext(async () => {
    await db
      .update(licenses)
      .set({
        offlineToken: token,
        offlineTokenJti: newJti,
        updatedAt: new Date(),
      })
      .where(eq(licenses.id, license.id as never));

    await db
      .update(deviceRegistrations)
      .set({ signedToken: token, lastSeenAt: new Date() })
      .where(
        and(
          eq(deviceRegistrations.licenseId, license.id as never),
          eq(deviceRegistrations.deviceFingerprint, fingerprint),
          isNull(deviceRegistrations.revokedAt),
        ),
      );
  });

  if (secretsRepo) {
    await secretsRepo.put(license.tenantId, "license.token.current", token);
    await secretsRepo.put(license.tenantId, "license.token.jti", newJti);
  }

  return { ok: true, action: "resigned", newJti };
}
