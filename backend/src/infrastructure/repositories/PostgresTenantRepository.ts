import { eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  ITenantRepository,
  TenantRow,
  CreateTenantInput,
} from "../../application/ports/ITenantRepository.js";
import { tenants } from "../orm/schemas/tenant.table.js";

type Row = typeof tenants.$inferSelect;

function toRow(r: Row): TenantRow {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    licenseStatus: r.licenseStatus,
    licenseType: r.licenseType,
    maxDevices: r.maxDevices,
    activationId: r.activationId,
    serverFingerprint: r.serverFingerprint,
    createdAt: r.createdAt,
  };
}

export class PostgresTenantRepository implements ITenantRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async findById(id: UUID): Promise<TenantRow | null> {
    // Tenant-directory read (category-3: own row OR platform). Callers are
    // bootstrap/platform flows — the per-tenant UI never reads the directory.
    return runWithPlatformContext(async () => {
      const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
      return row ? toRow(row) : null;
    });
  }

  async findBySlug(slug: string): Promise<TenantRow | null> {
    // Category-3 policy is "own row OR platform". Slugs are a platform-level
    // directory lookup (bootstrap uniqueness check), not per-tenant.
    return runWithPlatformContext(async () => {
      const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
      return row ? toRow(row) : null;
    });
  }

  async create(input: CreateTenantInput): Promise<TenantRow> {
    // Tenant creation is a bootstrap (platform) operation — a new tenant has
    // no verified JWT yet, so it runs under explicit platform context.
    return runWithPlatformContext(async () => {
      const [row] = await this.db
        .insert(tenants)
        .values({ name: input.name, slug: input.slug })
        .returning();
      if (!row) throw new Error("TENANT_INSERT_FAILED");
      return toRow(row);
    });
  }

  async setLicenseCache(
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
  ): Promise<void> {
    // Called from the license-provider / bootstrap paths to update the tenant
    // directory cache (category-3 rows are written platform-side).
    await runWithPlatformContext(async () => {
      await this.db
        .update(tenants)
        .set({
          licenseStatus: cache.licenseStatus,
          licenseType: cache.licenseType,
          maxDevices: cache.maxDevices,
          activationId: cache.activationId,
          serverFingerprint: cache.serverFingerprint,
          licenseKey: cache.licenseKey ?? null,
          licenseExpiresAt: cache.licenseExpiresAt ?? null,
          lastHeartbeatAt: cache.lastHeartbeatAt ?? null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, id));
    });
  }
}
