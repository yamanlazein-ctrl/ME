import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db as defaultDb, withTenantTx, type DB, type Tx } from "../orm/drizzle.js";
import type { ILicenseProvider } from "../../application/ports/ILicenseProvider.js";
import type {
  ActivationRequest,
  ActivationResult,
  DeviceInfo,
  HeartbeatResult,
} from "../../application/ports/ILicenseProvider.js";
import { LicenseTokenSigner } from "../auth/LicenseTokenSigner.js";
import type {
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";
import { licenses } from "../orm/schemas/license.table.js";
import { licenseActivations } from "../orm/schemas/license-activation.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import { licenseAuditEvents } from "../orm/schemas/license-audit-event.table.js";
import { tenants } from "../orm/schemas/tenant.table.js";

/**
 * Phase 0 sub-batch 0E — self-hosted license provider.
 *
 * Operates against the local `licenses` / `license_activations` /
 * `device_registrations` tables. In a single-process deployment
 * (LICENSE_SERVER_MODE != 'server' on the customer install, or
 * running the License Server entrypoint), this is the in-process
 * implementation. For a separate License Server deployment, the
 * customer install uses an HTTP-based provider (sub-batch 0J) that
 * calls the same logic remotely.
 *
 * The provider is intentionally stateless across calls; the DB is the
 * source of truth. The EdDSA offline token is signed with the
 * injected `LicenseTokenSigner` and persisted in the `secrets`
 * table by the activation use-case (not here — keeping this class
 * focused on the DB lifecycle).
 */
export class SelfHostedLicenseProvider implements ILicenseProvider {
  constructor(
    private readonly signer: LicenseTokenSigner,
    private readonly db: DB = defaultDb,
  ) {}

  async activate(req: ActivationRequest): Promise<ActivationResult> {
    return this.db.transaction(async (tx: Tx) => {
      // 1. Find the license by key.
      const [lic] = await tx
        .select()
        .from(licenses)
        .where(eq(licenses.key, req.key))
        .limit(1);
      if (!lic) {
        throw new Error("INVALID_LICENSE");
      }
      if (lic.status === "revoked" || lic.status === "expired") {
        throw new Error(`LICENSE_${lic.status.toUpperCase()}`);
      }

      // 2. Check the "one active activation per license" invariant
      //    (also enforced by the partial unique index in 0002).
      const [existingActive] = await tx
        .select()
        .from(licenseActivations)
        .where(
          and(
            eq(licenseActivations.licenseId, lic.id),
            isNull(licenseActivations.deactivatedAt),
          ),
        )
        .limit(1);

      // 3. Activation always targets the requesting tenant. Re-activation
      //    (reinstall / transfer to a new host) is allowed: any prior
      //    active activation is deactivated in step 4 and the license is
      //    rebound to the requesting tenant. This preserves the "one
      //    active activation per license" guarantee while letting a
      //    legitimate customer reuse their key across reinstalls/refreshes
      //    instead of being locked out by a stale binding.
      let tenantId = req.tenantId;

      // 4. Create the activation row (deactivating any prior one).
      if (existingActive) {
        await tx
          .update(licenseActivations)
          .set({ deactivatedAt: new Date(), deactivationReason: "re-activate" })
          .where(eq(licenseActivations.id, existingActive.id));
      }
      // R19: the partial unique index guarantees one active activation per
      // license. A concurrent activation could race past the check above;
      // map the constraint violation to a friendly error instead of 500.
      let activation: typeof licenseActivations.$inferSelect | undefined;
      try {
        [activation] = await tx.insert(licenseActivations).values({
          licenseId: lic.id,
          tenantId,
          serverFingerprint: req.serverFingerprint,
          serverFingerprintVersion: req.serverFingerprintVersion,
          hostname: req.hostname,
          appVersion: req.appVersion,
        }).returning();
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505") {
          throw new Error("ALREADY_ACTIVE");
        }
        throw e;
      }
      if (!activation) throw new Error("ACTIVATION_INSERT_FAILED");

      // 5. Update the tenant's denormalized cache columns.
      await tx
        .update(tenants)
        .set({
          licenseKey: lic.key,
          licenseExpiresAt: lic.expiresAt,
          licenseStatus: lic.status,
          licenseType: lic.type,
          maxDevices: lic.maxDevices,
          activationId: activation.id,
          serverFingerprint: req.serverFingerprint,
          lastHeartbeatAt: new Date(),
          // ── License Engine cache (frozen spec §6) ──
          licenseEdition: lic.edition,
          licensePlan: lic.plan,
          licenseVersion: lic.licenseVersion,
          productVersion: lic.productVersion,
          licenseModel: lic.licenseModel,
          licenseFeatures: lic.features,
          licenseLimits: lic.limits as never,
          licenseBindingType: lic.bindingType,
          licenseBindingValue: lic.bindingValue,
          transferPolicy: lic.transferPolicy as never,
          updatePolicy: lic.updatePolicy as never,
          backupPolicy: lic.backupPolicy as never,
          transfersUsed: lic.transfersUsed,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId));

      // 6. Bind the license to the tenant.
      await tx.update(licenses).set({ tenantId }).where(eq(licenses.id, lic.id));

      // 7. Append the audit event.
      await tx.insert(licenseAuditEvents).values({
        licenseId: lic.id,
        tenantId,
        eventType: "activated",
        payload: { activationId: activation.id, serverFingerprint: req.serverFingerprint },
        actor: "system",
      });

      // 8. Sign the offline token (outside the tx would be cleaner, but
      //    we keep it inside for atomicity — the signer is sync).
      const jti = randomUUID();
      const token = await this.signer.sign(
        {
          licenseId: lic.id,
          tenantId,
          features: lic.features,
          expiresAt: Math.floor((lic.expiresAt?.getTime() ?? Date.now() + 30 * 86400000) / 1000),
          serverFingerprint: req.serverFingerprint,
          edition: lic.edition ?? "",
          plan: lic.plan ?? "",
          licenseVersion: lic.licenseVersion,
          productVersion: lic.productVersion ?? "",
          licenseModel: lic.licenseModel as LicenseModel,
          bindingType: lic.bindingType ?? "machine",
          bindingValue: lic.bindingValue ?? req.serverFingerprint,
          limits: lic.limits as LicenseLimits,
          transferPolicy: lic.transferPolicy as TransferPolicy,
          updatePolicy: lic.updatePolicy as UpdatePolicy,
          backupPolicy: lic.backupPolicy as BackupPolicy,
        },
        { jti },
      );

      // R6: register the activating server as a device so admins can see
      // and manage installs. Signed token is stored on the device row.
      const deviceId = randomUUID();
      await tx.insert(deviceRegistrations).values({
        licenseId: lic.id,
        tenantId,
        deviceId,
        deviceFingerprint: req.serverFingerprint,
        deviceFingerprintVersion: req.serverFingerprintVersion,
        platform: "linux",
        name: req.hostname ?? "server",
        signedToken: token,
        signedTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(),
      });

      return {
        activationId: activation.id,
        tenantId,
        licenseId: lic.id,
        features: lic.features,
        offlineToken: token,
        jti,
        lease: {
          graceDays: lic.graceDays,
          nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6h
        },
        expiresAt: lic.expiresAt,
      };
    });
  }

  async refresh(activationId: string): Promise<HeartbeatResult> {
    return this.db.transaction(async (tx: Tx) => {
      const [activation] = await tx
        .select()
        .from(licenseActivations)
        .where(eq(licenseActivations.id, activationId))
        .limit(1);
      if (!activation || activation.deactivatedAt) {
        throw new Error("LICENSE_NOT_ACTIVE");
      }
      const [lic] = await tx
        .select()
        .from(licenses)
        .where(eq(licenses.id, activation.licenseId))
        .limit(1);
      if (!lic) throw new Error("LICENSE_NOT_FOUND");

      // Update last-seen.
      await tx
        .update(licenseActivations)
        .set({ lastSeenAt: new Date() })
        .where(eq(licenseActivations.id, activationId));
      await tx
        .update(tenants)
        .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(tenants.id, activation.tenantId));

      const graceRemainingDays = lic.expiresAt
        ? Math.max(0, Math.floor((lic.expiresAt.getTime() - Date.now()) / 86400000))
        : lic.graceDays;

      return {
        status: lic.status as HeartbeatResult["status"],
        graceRemainingDays,
        nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      };
    });
  }

  async deactivate(activationId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx: Tx) => {
      const [activation] = await tx
        .select()
        .from(licenseActivations)
        .where(eq(licenseActivations.id, activationId))
        .limit(1);
      if (!activation) return;
      await tx
        .update(licenseActivations)
        .set({ deactivatedAt: new Date(), deactivationReason: reason })
        .where(eq(licenseActivations.id, activationId));
      await tx.insert(licenseAuditEvents).values({
        licenseId: activation.licenseId,
        tenantId: activation.tenantId,
        eventType: "deactivated",
        payload: { reason },
        actor: "system",
      });
    });
  }

  async listDevices(activationId: string): Promise<DeviceInfo[]> {
    return withTenantTx(
      (await this.activationTenantId(activationId)) ?? "",
      async (tx: Tx) => {
        const rows = await tx
          .select()
          .from(deviceRegistrations)
          .where(eq(deviceRegistrations.licenseId, (await this.activationLicenseId(activationId)) ?? ""));
        return rows.map((r: (typeof deviceRegistrations.$inferSelect)) => ({
          id: r.id,
          deviceId: r.deviceId,
          platform: r.platform as DeviceInfo["platform"],
          name: r.name,
          lastSeenAt: r.lastSeenAt,
          revokedAt: r.revokedAt,
        }));
      },
    );
  }

  async revokeDevice(activationId: string, deviceId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx: Tx) => {
      const licenseId = await this.activationLicenseId(activationId);
      if (!licenseId) return;
      const [updated] = await tx
        .update(deviceRegistrations)
        .set({ revokedAt: new Date(), revokeReason: reason })
        .where(
          and(
            eq(deviceRegistrations.licenseId, licenseId),
            eq(deviceRegistrations.deviceId, deviceId),
          ),
        )
        .returning();
      if (updated) {
        const tenantId = await this.activationTenantId(activationId);
        await tx.insert(licenseAuditEvents).values({
          licenseId,
          tenantId,
          eventType: "device_revoked",
          payload: { deviceId, reason },
          actor: "admin",
        });
      }
    });
  }

  private async activationLicenseId(activationId: string): Promise<string | null> {
    const [a] = await this.db
      .select({ licenseId: licenseActivations.licenseId })
      .from(licenseActivations)
      .where(eq(licenseActivations.id, activationId))
      .limit(1);
    return a?.licenseId ?? null;
  }

  private async activationTenantId(activationId: string): Promise<string | null> {
    const [a] = await this.db
      .select({ tenantId: licenseActivations.tenantId })
      .from(licenseActivations)
      .where(eq(licenseActivations.id, activationId))
      .limit(1);
    return a?.tenantId ?? null;
  }
}
