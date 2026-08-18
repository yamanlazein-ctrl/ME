import { and, desc, eq, gte, lte, count, isNull, type SQL } from "drizzle-orm";
import { db as defaultDb, withTenantTx, type DB } from "../orm/drizzle.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  ILicenseRepository,
  LicenseRow,
  ActivationRow,
  DeviceRow,
  LicenseEventRow,
} from "../../application/ports/ILicenseRepository.js";
import { licenses } from "../orm/schemas/license.table.js";
import { licenseActivations } from "../orm/schemas/license-activation.table.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import { licenseAuditEvents } from "../orm/schemas/license-audit-event.table.js";
import type {
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";

type LRow = typeof licenses.$inferSelect;
type ARow = typeof licenseActivations.$inferSelect;
type DRow = typeof deviceRegistrations.$inferSelect;
type ERow = typeof licenseAuditEvents.$inferSelect;

function toLicense(r: LRow): LicenseRow {
  return {
    id: r.id,
    key: r.key,
    type: r.type,
    status: r.status,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    graceDays: r.graceDays,
    maxDevices: r.maxDevices,
    features: r.features,
    vendorId: r.vendorId,
    vendorMetadata: (r.vendorMetadata as Record<string, unknown> | null) ?? null,
    tenantId: r.tenantId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    edition: r.edition,
    plan: r.plan,
    licenseVersion: r.licenseVersion,
    productVersion: r.productVersion,
    licenseModel: r.licenseModel as LicenseModel,
    bindingType: r.bindingType,
    bindingValue: r.bindingValue,
    limits: (r.limits as LicenseLimits) ?? { users: 0, devices: 0, branches: 0, warehouses: 0, storage_gb: 0, api_calls: 0 },
    transferPolicy: (r.transferPolicy as TransferPolicy) ?? { allowed: true, max_transfers: 3, requires_super_admin: true },
    updatePolicy: (r.updatePolicy as UpdatePolicy) ?? { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
    backupPolicy: (r.backupPolicy as BackupPolicy) ?? { enabled: true, cloud_backup: false, max_backups: 30 },
    transfersUsed: r.transfersUsed,
  };
}

function toActivation(r: ARow): ActivationRow {
  return {
    id: r.id,
    licenseId: r.licenseId,
    tenantId: r.tenantId,
    serverFingerprint: r.serverFingerprint,
    serverFingerprintVersion: r.serverFingerprintVersion,
    hostname: r.hostname,
    appVersion: r.appVersion,
    lastSeenAt: r.lastSeenAt,
    deactivatedAt: r.deactivatedAt,
    deactivationReason: r.deactivationReason,
    notes: r.notes,
    createdAt: r.createdAt,
  };
}

function toDevice(r: DRow): DeviceRow {
  return {
    id: r.id,
    licenseId: r.licenseId,
    tenantId: r.tenantId,
    deviceId: r.deviceId,
    deviceFingerprint: r.deviceFingerprint,
    deviceFingerprintVersion: r.deviceFingerprintVersion,
    platform: r.platform,
    name: r.name,
    signedToken: r.signedToken,
    signedTokenExpiresAt: r.signedTokenExpiresAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
    revokeReason: r.revokeReason,
    createdAt: r.createdAt,
  };
}

function toEvent(r: ERow): LicenseEventRow {
  return {
    id: Number(r.id),
    licenseId: r.licenseId,
    tenantId: r.tenantId,
    eventType: r.eventType,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    actor: r.actor,
    ipAddress: r.ipAddress,
    requestId: r.requestId,
    createdAt: r.createdAt,
  };
}

export class PostgresLicenseRepository implements ILicenseRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async findByKey(key: string): Promise<LicenseRow | null> {
    const [row] = await this.db
      .select()
      .from(licenses)
      .where(eq(licenses.key, key))
      .limit(1);
    return row ? toLicense(row) : null;
  }

  async findById(id: UUID): Promise<LicenseRow | null> {
    const [row] = await this.db
      .select()
      .from(licenses)
      .where(eq(licenses.id, id))
      .limit(1);
    return row ? toLicense(row) : null;
  }

  async findActiveForTenant(tenantId: UUID): Promise<LicenseRow | null> {
    return withTenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenantId), eq(licenses.status, "active")))
        .limit(1);
      return row ? toLicense(row) : null;
    });
  }

  async findLatestForTenant(tenantId: UUID): Promise<LicenseRow | null> {
    return withTenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(licenses)
        .where(eq(licenses.tenantId, tenantId))
        .orderBy(desc(licenses.createdAt))
        .limit(1);
      return row ? toLicense(row) : null;
    });
  }

  async list(filter: { tenantId?: UUID; status?: string }): Promise<LicenseRow[]> {
    const where: SQL[] = [];
    if (filter.tenantId) where.push(eq(licenses.tenantId, filter.tenantId));
    if (filter.status) where.push(eq(licenses.status, filter.status));
    const rows = await this.db
      .select()
      .from(licenses)
      .where(where.length ? and(...where) : undefined);
    return rows.map(toLicense);
  }

  async findActivationById(id: UUID): Promise<ActivationRow | null> {
    const [row] = await this.db
      .select()
      .from(licenseActivations)
      .where(eq(licenseActivations.id, id))
      .limit(1);
    return row ? toActivation(row) : null;
  }

  async findActiveActivationForLicense(licenseId: UUID): Promise<ActivationRow | null> {
    const [row] = await this.db
      .select()
      .from(licenseActivations)
      .where(
        and(
          eq(licenseActivations.licenseId, licenseId),
          isNull(licenseActivations.deactivatedAt),
        ),
      )
      .limit(1);
    return row ? toActivation(row) : null;
  }

  async listDevices(licenseId: UUID): Promise<DeviceRow[]> {
    const rows = await this.db
      .select()
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.licenseId, licenseId));
    return rows.map(toDevice);
  }

  async logEvent(event: Omit<LicenseEventRow, "id" | "createdAt">): Promise<void> {
    await this.db.insert(licenseAuditEvents).values({
      licenseId: event.licenseId,
      tenantId: event.tenantId,
      eventType: event.eventType,
      payload: event.payload,
      actor: event.actor,
      ipAddress: event.ipAddress,
      requestId: event.requestId,
    });
  }

  async listEvents(
    filter: { licenseId?: UUID; tenantId?: UUID; eventType?: string; since?: Date; until?: Date },
    pagination: { page: number; pageSize: number },
  ): Promise<{ data: LicenseEventRow[]; total: number }> {
    const where: SQL[] = [];
    if (filter.licenseId) where.push(eq(licenseAuditEvents.licenseId, filter.licenseId));
    if (filter.tenantId) where.push(eq(licenseAuditEvents.tenantId, filter.tenantId));
    if (filter.eventType) where.push(eq(licenseAuditEvents.eventType, filter.eventType));
    if (filter.since) where.push(gte(licenseAuditEvents.createdAt, filter.since));
    if (filter.until) where.push(lte(licenseAuditEvents.createdAt, filter.until));

    const w = where.length ? and(...where) : undefined;
    const offset = (pagination.page - 1) * pagination.pageSize;
    const rows = await this.db
      .select()
      .from(licenseAuditEvents)
      .where(w)
      .orderBy(desc(licenseAuditEvents.createdAt))
      .limit(pagination.pageSize)
      .offset(offset);
    const [{ c }] = await this.db
      .select({ c: count() })
      .from(licenseAuditEvents)
      .where(w);
    return { data: rows.map(toEvent), total: Number(c) };
  }
}
