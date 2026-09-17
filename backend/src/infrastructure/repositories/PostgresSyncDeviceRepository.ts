import { and, desc, eq, sql } from "drizzle-orm";
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
import {
  isLicenseFingerprintRevoked,
  revokeLicenseDevicesByFingerprint,
} from "../device/linkedDeviceRevocation.js";

export class PostgresSyncDeviceRepository implements ISyncDeviceRepository {
  constructor(private readonly db: DB) {}

  async registerOrTouch(input: IRegisterSyncDeviceInput): Promise<SyncDeviceRow> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const fingerprintVersion = input.deviceFingerprintVersion ?? 1;
      const touch = {
        lastSeenByUserId: input.userId,
        deviceFingerprintVersion: fingerprintVersion,
        platform: input.platform,
        hostname: input.hostname ?? null,
        label: input.label ?? input.hostname ?? null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      };

      // Device-gate binding: when the device asserts its own UUID, the row
      // uses it as its id so hub push/pull gates recognize it.
      //
      // 4B: an existing row is only adopted by a caller who can prove it is
      // that device (fingerprint match). Previously the fingerprint was
      // OVERWRITTEN from input, so any tenant user could take over any device
      // id — the forged-device-id hole.
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
          // The asserted id is unknown, but this fingerprint may already be
          // registered under a different id (the client-asserted-id path is
          // optional). Resolving by fingerprint keeps the
          // (tenant, fingerprint) uniqueness invariant instead of crashing on
          // it, and returns the canonical id to the caller.
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
        // 4B: revocation is terminal for the device itself — registration is
        // the first thing a compromised device would use to re-establish
        // authority, so it must be refused here rather than only on push.
        if (existing.revokedAt) {
          throw new SyncDeviceRevokedError(existing.revokeReason);
        }
        if (await isLicenseFingerprintRevoked(this.db, input.tenantId, input.deviceFingerprint)) {
          throw new SyncDeviceRevokedError("license_revoked");
        }
        const [updated] = await this.db
          .update(syncDevices)
          .set({
            ...touch,
            // 4B binding: add the registering user to the device's authorized
            // set. `CASE` keeps the value stable for an already-bound user and
            // makes concurrent registrations safe (the UPDATE re-reads under
            // row lock; no read-modify-write race, no duplicate entries).
            authorizedUserIds: sql`CASE
              WHEN ${input.userId}::uuid = ANY(${syncDevices.authorizedUserIds})
                THEN ${syncDevices.authorizedUserIds}
              ELSE array_append(${syncDevices.authorizedUserIds}, ${input.userId}::uuid)
            END`,
          })
          .where(eq(syncDevices.id, existing.id))
          .returning();
        return updated;
      }

      if (await isLicenseFingerprintRevoked(this.db, input.tenantId, input.deviceFingerprint)) {
        throw new SyncDeviceRevokedError("license_revoked");
      }

      const [created] = await this.db
        .insert(syncDevices)
        .values({
          ...(input.deviceId ? { id: input.deviceId } : {}),
          tenantId: input.tenantId,
          deviceFingerprint: input.deviceFingerprint,
          ...touch,
          // First registration binds its user; the device can only be used by
          // users who later prove possession of the same machine.
          authorizedUserIds: [input.userId],
        })
        .returning();
      return created;
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
      if (
        !row.revokedAt &&
        (await isLicenseFingerprintRevoked(this.db, tenantId, row.deviceFingerprint))
      ) {
        return {
          ...row,
          revokedAt: new Date(0),
          revokeReason: row.revokeReason ?? "license_revoked",
        };
      }
      return row;
    });
  }

  async listForTenant(tenantId: string, limit = 200): Promise<SyncDeviceRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      return this.db
        .select()
        .from(syncDevices)
        .where(eq(syncDevices.tenantId, tenantId))
        .orderBy(desc(syncDevices.lastSeenAt))
        .limit(Math.min(Math.max(limit, 1), 500));
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
      return row;
    });
  }
}
