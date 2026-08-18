import type { UUID } from "../../domain/types/index.js";

/**
 * Phase 0 sub-batch 0F — tenant repository port.
 *
 * The `tenants` table is the parent of all business data. The port is
 * intentionally narrow: just the operations the bootstrap + license
 * flow need. Day-to-day tenant context (read by `req.tenantContext`)
 * comes from the JWT, not the DB.
 */
export interface TenantRow {
  id: UUID;
  name: string;
  slug: string;
  status: string;
  licenseStatus: string;
  licenseType: string;
  maxDevices: number;
  activationId: UUID | null;
  serverFingerprint: string | null;
  createdAt: Date;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
}

export interface ITenantRepository {
  findById(id: UUID): Promise<TenantRow | null>;
  findBySlug(slug: string): Promise<TenantRow | null>;
  create(input: CreateTenantInput): Promise<TenantRow>;
  setLicenseCache(
    id: UUID,
    cache: {
      licenseStatus: string;
      licenseType: string;
      maxDevices: number;
      activationId: UUID | null;
      serverFingerprint: string | null;
      licenseKey?: string | null;
      licenseExpiresAt?: Date | null;
      lastHeartbeatAt?: Date | null;
    },
  ): Promise<void>;
}
