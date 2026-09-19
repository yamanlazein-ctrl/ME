import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import {
  SyncDeviceFingerprintMismatchError,
  SyncDeviceRevokedError,
  type IRegisterSyncDeviceInput,
  type ISyncDeviceRepository,
  type SyncDeviceRow,
} from "../../application/ports/ISyncDeviceRepository.js";
import { syncDevices } from "../orm/schemas/sync-device.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import { syncDeviceAuthorizedUsers } from "../orm/schemas/sync-device-authorized-user.table.js";
import { users } from "../orm/schemas/user.table.js";
import {
  isLicenseFingerprintRevoked,
  revokeLicenseDevicesByFingerprint,
} from "../device/linkedDeviceRevocation.js";

export class PostgresSyncDeviceRepository implements ISyncDeviceRepository {
  constructor(private readonly db: DB) {}

  /** Insert join row + rebuild denormalized authorized_user_ids cache. */
  private async bindUser(deviceId: string, tenantId: string, userId: string): Promise<string[]> {
    await this.db
      .insert(syncDeviceAuthorizedUsers)
      .values({ deviceId, tenantId, userId })
      .onConflictDoNothing();

    // Drop bindings for inactive / wrong-tenant users (soft-delete cleanup).
    await this.db.execute(sql`
      DELETE FROM sync_device_authorized_users AS a
      USING users AS u
      WHERE a.device_id = ${deviceId}::uuid
        AND a.tenant_id = ${tenantId}::uuid
        AND a.user_id = u.id
        AND (u.tenant_id IS DISTINCT FROM ${tenantId}::uuid OR u.active = false)
    `);

    const rows = await this.db
      .select({ userId: syncDeviceAuthorizedUsers.userId })
      .from(syncDeviceAuthorizedUsers)
      .where(
        and(
          eq(syncDeviceAuthorizedUsers.deviceId, deviceId),
          eq(syncDeviceAuthorizedUsers.tenantId, tenantId),
        ),
      );

    const ids = rows.map((r) => r.userId);
    await this.db
      .update(syncDevices)
      .set({ authorizedUserIds: ids })
      .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.tenantId, tenantId)));
    return ids;
  }

  private async hydrateAuthorized(row: SyncDeviceRow): Promise<SyncDeviceRow> {
    const bound = await this.db
      .select({ userId: syncDeviceAuthorizedUsers.userId })
      .from(syncDeviceAuthorizedUsers)
      .innerJoin(
        users,
        and(
          eq(users.id, syncDeviceAuthorizedUsers.userId),
          eq(users.tenantId, syncDeviceAuthorizedUsers.tenantId),
          eq(users.active, true),
        ),
      )
      .where(
        and(
          eq(syncDeviceAuthorizedUsers.deviceId, row.id),
          eq(syncDeviceAuthorizedUsers.tenantId, row.tenantId),
        ),
      );
    return { ...row, authorizedUserIds: bound.map((b) => b.userId) };
  }

  async registerOrTouch(input: IRegisterSyncDeviceInput): Promise<SyncDeviceRow> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const fingerprintVersion = input.deviceFingerprintVersion ?? 1;
      // P1-13: resolve the canonical license registration by tenant +
      // fingerprint. A sync-only legacy row is allowed to register once, but
      // new rows are always linked when activation already exists.
      const [registration] = await this.db
        .select({ id: deviceRegistrations.id })
        .from(deviceRegistrations)
        .where(
          and(
            eq(deviceRegistrations.tenantId, input.tenantId),
            eq(deviceRegistrations.deviceFingerprint, input.deviceFingerprint),
            isNull(deviceRegistrations.revokedAt),
          ),
        )
        .limit(1);
      const touch = {
        lastSeenByUserId: input.userId,
        deviceFingerprintVersion: fingerprintVersion,
        platform: input.platform,
        hostname: input.hostname ?? null,
        label: input.label ?? input.hostname ?? null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      };

      let existing: SyncDeviceRow | undefined;
      if (input.deviceId) {
        const [byId] = await this.db
          .select()
          .from(syncDevices)
          .where(
            and(eq(syncDevices.tenantId, input.tenantId), eq(syncDevices.id, input.deviceId)),
          )
          .limit(1);
        if (byId) {
          if (byId.deviceFingerprint !== input.deviceFingerprint) {
            throw new SyncDeviceFingerprintMismatchError(byId.id);
          }
          existing = byId;
        } else {
          const [byFp] = await this.db
            .select()
            .from(syncDevices)
            .where(
              and(
                eq(syncDevices.tenantId, input.tenantId),
                eq(syncDevices.deviceFingerprint, input.deviceFingerprint),
              ),
            )
            .limit(1);
          existing = byFp;
        }
      } else {
        const [byFp] = await this.db
          .select()
          .from(syncDevices)
          .where(
            and(
              eq(syncDevices.tenantId, input.tenantId),
              eq(syncDevices.deviceFingerprint, input.deviceFingerprint),
            ),
          )
          .limit(1);
        existing = byFp;
      }

      if (existing) {
        if (existing.revokedAt) {
          throw new SyncDeviceRevokedError(existing.revokeReason);
        }
        const touchWithRegistration = {
          ...touch,
          ...(registration ? { deviceRegistrationId: registration.id } : {}),
        };
        if (await isLicenseFingerprintRevoked(this.db, input.tenantId, input.deviceFingerprint)) {
          throw new SyncDeviceRevokedError("license_revoked");
        }
        const [updated] = await this.db
          .update(syncDevices)
          .set(touchWithRegistration)
          .where(eq(syncDevices.id, existing.id))
          .returning();
        const authorizedUserIds = await this.bindUser(updated.id, input.tenantId, input.userId);
        return { ...updated, authorizedUserIds };
      }

      if (await isLicenseFingerprintRevoked(this.db, input.tenantId, input.deviceFingerprint)) {
        throw new SyncDeviceRevokedError("license_revoked");
      }

      const [created] = await this.db
        .insert(syncDevices)
        .values({
          ...(input.deviceId ? { id: input.deviceId } : {}),
          tenantId: input.tenantId,
          ...(registration ? { deviceRegistrationId: registration.id } : {}),
          deviceFingerprint: input.deviceFingerprint,
          ...touch,
          authorizedUserIds: [],
        })
        .returning();
      const authorizedUserIds = await this.bindUser(created.id, input.tenantId, input.userId);
      return { ...created, authorizedUserIds };
    });
  }

  async findById(tenantId: string, deviceId: string): Promise<SyncDeviceRow | null> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select()
        .from(syncDevices)
        .where(and(eq(syncDevices.tenantId, tenantId), eq(syncDevices.id, deviceId)))
        .limit(1);
      if (!row) return null;
      const hydrated = await this.hydrateAuthorized(row);
      if (
        !hydrated.revokedAt &&
        (await isLicenseFingerprintRevoked(this.db, tenantId, hydrated.deviceFingerprint))
      ) {
        return {
          ...hydrated,
          revokedAt: new Date(0),
          revokeReason: hydrated.revokeReason ?? "license_revoked",
        };
      }
      return hydrated;
    });
  }

  async listForTenant(tenantId: string, limit = 200): Promise<SyncDeviceRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncDevices)
        .where(eq(syncDevices.tenantId, tenantId))
        .orderBy(desc(syncDevices.lastSeenAt))
        .limit(Math.min(Math.max(limit, 1), 500));
      return Promise.all(rows.map((r) => this.hydrateAuthorized(r)));
    });
  }

  async setRevoked(
    tenantId: string,
    deviceId: string,
    revoked: boolean,
    reason: string | null,
  ): Promise<SyncDeviceRow | null> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncDevices)
        .set({
          revokedAt: revoked ? new Date() : null,
          revokeReason: revoked ? (reason ?? "operator_action") : null,
          updatedAt: new Date(),
        })
        .where(and(eq(syncDevices.tenantId, tenantId), eq(syncDevices.id, deviceId)))
        .returning();
      if (!row) return null;
      await revokeLicenseDevicesByFingerprint(
        this.db,
        tenantId,
        row.deviceFingerprint,
        revoked,
        reason,
      );
      return this.hydrateAuthorized(row);
    });
  }

  /** DFP-014: soft-deleted / deactivated users lose device authority immediately. */
  async revokeUserAuthorization(tenantId: string, userId: string): Promise<void> {
    return runWithTenantContext({ tenantId }, async () => {
      const affected = await this.db
        .select({ deviceId: syncDeviceAuthorizedUsers.deviceId })
        .from(syncDeviceAuthorizedUsers)
        .where(
          and(
            eq(syncDeviceAuthorizedUsers.tenantId, tenantId),
            eq(syncDeviceAuthorizedUsers.userId, userId),
          ),
        );
      if (affected.length === 0) return;

      await this.db
        .delete(syncDeviceAuthorizedUsers)
        .where(
          and(
            eq(syncDeviceAuthorizedUsers.tenantId, tenantId),
            eq(syncDeviceAuthorizedUsers.userId, userId),
          ),
        );

      const deviceIds = affected.map((a) => a.deviceId);
      for (const deviceId of deviceIds) {
        const remaining = await this.db
          .select({ userId: syncDeviceAuthorizedUsers.userId })
          .from(syncDeviceAuthorizedUsers)
          .where(
            and(
              eq(syncDeviceAuthorizedUsers.deviceId, deviceId),
              eq(syncDeviceAuthorizedUsers.tenantId, tenantId),
            ),
          );
        await this.db
          .update(syncDevices)
          .set({ authorizedUserIds: remaining.map((r) => r.userId), updatedAt: new Date() })
          .where(and(eq(syncDevices.id, deviceId), eq(syncDevices.tenantId, tenantId)));
      }
    });
  }
}
