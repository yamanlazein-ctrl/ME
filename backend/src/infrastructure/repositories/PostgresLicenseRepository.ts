import { and, desc, eq, gte, lte, count, isNull, isNotNull, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, type DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
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
import { tenants } from "../orm/schemas/tenant.table.js";
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
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    customerNotes: r.customerNotes,
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
    limits: (r.limits as LicenseLimits) ?? {
      users: 0,
      devices: 0,
      branches: 0,
      warehouses: 0,
      storage_gb: 0,
      api_calls: 0,
    },
    transferPolicy: (r.transferPolicy as TransferPolicy) ?? {
      allowed: true,
      max_transfers: 3,
      requires_super_admin: true,
    },
    updatePolicy: (r.updatePolicy as UpdatePolicy) ?? {
      channel: "stable",
      allow_updates: true,
      minimum_version: "1.0.0",
    },
    backupPolicy: (r.backupPolicy as BackupPolicy) ?? {
      enabled: true,
      cloud_backup: false,
      max_backups: 30,
    },
    transfersUsed: r.transfersUsed,
    offlineToken: r.offlineToken,
    offlineTokenJti: r.offlineTokenJti,
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
    // Case-insensitive: ActivationScreen historically uppercased keys; admin/
    // seed keys may differ in hex case. Exact match first, then lower().
    const trimmed = key.trim();
    const [exact] = await this.db.select().from(licenses).where(eq(licenses.key, trimmed)).limit(1);
    if (exact) return toLicense(exact);
    const [row] = await this.db
      .select()
      .from(licenses)
      .where(sql`lower(${licenses.key}) = lower(${trimmed})`)
      .limit(1);
    return row ? toLicense(row) : null;
  }

  async findById(id: UUID): Promise<LicenseRow | null> {
    const [row] = await this.db.select().from(licenses).where(eq(licenses.id, id)).limit(1);
    return row ? toLicense(row) : null;
  }

  async findActiveForTenant(tenantId: UUID): Promise<LicenseRow | null> {
    const latest = await this.findLatestForTenant(tenantId);
    if (latest && latest.status === "active") return latest;
    return null;
  }

  async findLatestForTenant(tenantId: UUID): Promise<LicenseRow | null> {
    // Platform read: tenant entitlement pointers + license SoT must resolve
    // even when the caller's GUC is wrong during bootstrap/auth.
    return runWithPlatformContext(async () => {
      const [tenant] = await this.db
        .select({
          licenseKey: tenants.licenseKey,
          activationId: tenants.activationId,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) return null;

      if (tenant.licenseKey) {
        const trimmed = tenant.licenseKey.trim();
        const [byKey] = await this.db
          .select()
          .from(licenses)
          .where(eq(licenses.key, trimmed))
          .limit(1);
        if (byKey) return toLicense(byKey);
        const [byKeyCi] = await this.db
          .select()
          .from(licenses)
          .where(sql`lower(${licenses.key}) = lower(${trimmed})`)
          .limit(1);
        if (byKeyCi) return toLicense(byKeyCi);
        // Pointer set but SoT row missing/wrong — do not fall back to a
        // co-located baked or older license (would silently hijack).
        return null;
      }

      if (tenant.activationId) {
        const [act] = await this.db
          .select()
          .from(licenseActivations)
          .where(eq(licenseActivations.id, tenant.activationId))
          .limit(1);
        if (act) {
          const [lic] = await this.db
            .select()
            .from(licenses)
            .where(eq(licenses.id, act.licenseId))
            .limit(1);
          if (lic) return toLicense(lic);
        }
      }

      // Live activation for this tenant (reinstall path before cache rewrite).
      const [liveAct] = await this.db
        .select()
        .from(licenseActivations)
        .where(
          and(eq(licenseActivations.tenantId, tenantId), isNull(licenseActivations.deactivatedAt)),
        )
        .orderBy(desc(licenseActivations.createdAt))
        .limit(1);
      if (liveAct) {
        const [lic] = await this.db
          .select()
          .from(licenses)
          .where(eq(licenses.id, liveAct.licenseId))
          .limit(1);
        if (lic) return toLicense(lic);
      }

      // Pre-activation / test fixtures: prefer a non-baked bound row over a
      // Desktop offline_token bake so a stale bake cannot win by created_at.
      const [nonBaked] = await this.db
        .select()
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenantId), isNull(licenses.offlineToken)))
        .orderBy(desc(licenses.createdAt))
        .limit(1);
      if (nonBaked) return toLicense(nonBaked);

      const [bakedOnly] = await this.db
        .select()
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenantId), isNotNull(licenses.offlineToken)))
        .orderBy(desc(licenses.createdAt))
        .limit(1);
      if (bakedOnly) return toLicense(bakedOnly);

      return null;
    });
  }

  async findBakedForTenant(tenantId: UUID): Promise<LicenseRow | null> {
    return runWithPlatformContext(async () => {
      const [tenant] = await this.db
        .select({
          licenseKey: tenants.licenseKey,
          activationId: tenants.activationId,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!tenant) return null;

      // Tenant already bound to a non-baked (or different) key → never return
      // a mismatched baked row.
      if (tenant.licenseKey) {
        const [row] = await this.db
          .select()
          .from(licenses)
          .where(
            and(
              eq(licenses.key, tenant.licenseKey),
              isNotNull(licenses.offlineToken),
            ),
          )
          .limit(1);
        return row ? toLicense(row) : null;
      }

      if (tenant.activationId) {
        const [act] = await this.db
          .select()
          .from(licenseActivations)
          .where(eq(licenseActivations.id, tenant.activationId))
          .limit(1);
        if (act) {
          const [row] = await this.db
            .select()
            .from(licenses)
            .where(
              and(eq(licenses.id, act.licenseId), isNotNull(licenses.offlineToken)),
            )
            .limit(1);
          return row ? toLicense(row) : null;
        }
      }

      // Pre-activation Desktop bake: sole baked row for this tenant.
      const [row] = await this.db
        .select()
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenantId), isNotNull(licenses.offlineToken)))
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
        and(eq(licenseActivations.licenseId, licenseId), isNull(licenseActivations.deactivatedAt)),
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
    const [{ c }] = await this.db.select({ c: count() }).from(licenseAuditEvents).where(w);
    return { data: rows.map(toEvent), total: Number(c) };
  }
}
