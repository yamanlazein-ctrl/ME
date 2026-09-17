import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
import { licenses } from "../orm/schemas/license.table.js";
import { tenants } from "../orm/schemas/tenant.table.js";
import { logger } from "../config/logger.js";

/**
 * Detach stale Desktop baked licenses that share a tenant_id with a different
 * active entitlement (tenants.license_key).
 *
 * Does NOT delete rows, business data, users, or PINs. Only clears
 * `licenses.tenant_id` when the baked row is not the tenant's current key.
 * Idempotent.
 */
export async function detachOrphanBakedLicenses(db: DB): Promise<number> {
  return runWithPlatformContext(async () => {
    const orphans = await db
      .select({
        id: licenses.id,
        key: licenses.key,
        tenantId: licenses.tenantId,
      })
      .from(licenses)
      .innerJoin(tenants, eq(licenses.tenantId, tenants.id))
      .where(
        and(
          isNotNull(licenses.offlineToken),
          isNotNull(tenants.licenseKey),
          ne(licenses.key, tenants.licenseKey),
        ),
      );

    if (orphans.length === 0) return 0;

    for (const row of orphans) {
      await db
        .update(licenses)
        .set({ tenantId: null, updatedAt: new Date() })
        .where(eq(licenses.id, row.id));
    }

    logger.info(
      {
        count: orphans.length,
        keys: orphans.map((o) => o.key),
      },
      "Detached orphan baked licenses from active tenant entitlement",
    );
    return orphans.length;
  });
}

/**
 * SQL variant for pool.query boot path (desktop / ERP startup).
 */
export async function detachOrphanBakedLicensesSql(
  query: (sqlText: string) => Promise<unknown>,
): Promise<number> {
  // Platform mode so RLS on licenses/tenants does not hide rows.
  await query(`SELECT set_config('app.platform_mode', 'on', false)`);
  const result = (await query(`
    WITH orphaned AS (
      SELECT l.id
      FROM licenses l
      INNER JOIN tenants t ON t.id = l.tenant_id
      WHERE l.offline_token IS NOT NULL
        AND t.license_key IS NOT NULL
        AND t.license_key <> l.key
    ),
    updated AS (
      UPDATE licenses
      SET tenant_id = NULL, updated_at = now()
      WHERE id IN (SELECT id FROM orphaned)
      RETURNING id
    )
    SELECT count(*)::int AS n FROM updated
  `)) as { rows?: Array<{ n: number }> };

  const n = Number(result?.rows?.[0]?.n ?? 0);
  if (n > 0) {
    logger.info({ count: n }, "Detached orphan baked licenses from active tenant entitlement");
  }
  return n;
}
