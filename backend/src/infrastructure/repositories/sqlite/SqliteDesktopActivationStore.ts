// PORTED-FROM: src/infrastructure/repositories/PostgresDesktopActivationStore.ts sha256=cb0da0d47168300ddff9f7398a83c2c533581f11f596fbc44e1a7d541608cb24
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
﻿/**
 * PostgreSQL transaction for desktop verify-only activation — moved verbatim from
 * application/use-cases/setup/recordDesktopDeviceActivation.ts (S1).
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { runWithPlatformContext } from "../../orm/tenant-context.js";
import { licenseActivations } from "../../orm/sqlite/schemas/license-activation.table.js";
import { deviceRegistrations } from "../../orm/sqlite/schemas/device-registration.table.js";
import { tenants } from "../../orm/sqlite/schemas/tenant.table.js";
import { licenseAuditEvents } from "../../orm/sqlite/schemas/license-audit-event.table.js";
import { licenses } from "../../orm/sqlite/schemas/license.table.js";
import { fingerprintsMatch } from "../../../domain/licensing/installationIdentity.js";
import type { DesktopActivationInput, IDesktopActivationStore } from "../../../application/ports/IDesktopActivationStore.js";

export class SqliteDesktopActivationStore implements IDesktopActivationStore {
  constructor(private readonly db: DB) {}

  record(input: DesktopActivationInput): Promise<{ activationId: string }> {
    return runWithPlatformContext(() =>
      this.db.transaction(async (tx) => {
      // Serialize the count-then-insert against every activation for this license.
      const [license] = await tx
        .select({ id: licenses.id })
        .from(licenses)
        .where(eq(licenses.id, input.licenseId));
      if (!license) throw new Error("LICENSE_NOT_FOUND");

      const [existingActive] = await tx
        .select()
        .from(licenseActivations)
        .where(
          and(
            eq(licenseActivations.licenseId, input.licenseId),
            isNull(licenseActivations.deactivatedAt),
          ),
        )
        .limit(1);

      let activationId: string;
      if (
        existingActive &&
        existingActive.tenantId === input.tenantId &&
        existingActive.serverFingerprint === input.serverFingerprint
      ) {
        await tx
          .update(licenseActivations)
          .set({
            lastSeenAt: new Date(),
            hostname: input.hostname ?? existingActive.hostname,
            appVersion: input.appVersion ?? existingActive.appVersion,
            serverFingerprintVersion: input.serverFingerprintVersion,
          })
          .where(eq(licenseActivations.id, existingActive.id));
        activationId = existingActive.id;
      } else {
        if (existingActive) {
          await tx
            .update(licenseActivations)
            .set({
              deactivatedAt: new Date(),
              deactivationReason: "re-activate",
            })
            .where(eq(licenseActivations.id, existingActive.id));
        }
        const [activation] = await tx
          .insert(licenseActivations)
          .values({
            licenseId: input.licenseId,
            tenantId: input.tenantId,
            serverFingerprint: input.serverFingerprint,
            serverFingerprintVersion: input.serverFingerprintVersion,
            hostname: input.hostname ?? null,
            appVersion: input.appVersion ?? null,
          })
          .returning();
        if (!activation) throw new Error("ACTIVATION_INSERT_FAILED");
        activationId = activation.id;
      }

      await tx
        .update(tenants)
        .set({
          activationId,
          serverFingerprint: input.serverFingerprint,
          lastHeartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, input.tenantId));

      const live = await tx
        .select()
        .from(deviceRegistrations)
        .where(
          and(
            eq(deviceRegistrations.licenseId, input.licenseId),
            isNull(deviceRegistrations.revokedAt),
          ),
        );

      const existingDevice = live.find((d) =>
        fingerprintsMatch(d.deviceFingerprint, input.serverFingerprint),
      );
      if (existingDevice) {
        await tx
          .update(deviceRegistrations)
          .set({
            deviceFingerprint: input.serverFingerprint,
            deviceFingerprintVersion: input.serverFingerprintVersion,
            platform: input.platform ?? existingDevice.platform,
            name: input.hostname ?? existingDevice.name,
            lastSeenAt: new Date(),
          })
          .where(eq(deviceRegistrations.id, existingDevice.id));
      } else {
        if (input.maxDevices > 0 && live.length >= input.maxDevices) {
          throw new Error("DEVICE_LIMIT_REACHED");
        }
        await tx.insert(deviceRegistrations).values({
          licenseId: input.licenseId,
          tenantId: input.tenantId,
          deviceId: randomUUID(),
          deviceFingerprint: input.serverFingerprint,
          deviceFingerprintVersion: input.serverFingerprintVersion,
          platform: input.platform ?? "windows",
          name: input.hostname ?? "desktop",
          lastSeenAt: new Date(),
        });
      }

      await tx.insert(licenseAuditEvents).values({
        licenseId: input.licenseId,
        tenantId: input.tenantId,
        eventType: "activated",
        payload: {
          activationId,
          serverFingerprint: input.serverFingerprint,
          desktopVerifyOnly: true,
        },
        actor: "system",
      });
        return { activationId };
      }),
    );
  }
}
