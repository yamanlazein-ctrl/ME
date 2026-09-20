import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../src/infrastructure/orm/drizzle.js";
import {
  revokeLicenseDevicesByFingerprint,
  revokeSyncDevicesByFingerprint,
} from "../src/infrastructure/device/linkedDeviceRevocation.js";
import { runWithTenantContext, runWithPlatformContext } from "../src/infrastructure/orm/tenant-context.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

describe("license ↔ sync device fingerprint link", () => {
  let reachable = false;
  let tenantId = "";
  let fingerprint = "";
  let licenseId = "";
  let syncId = "";
  let licId = "";

  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;

    tenantId = randomUUID();
    fingerprint = `fp-${randomUUID()}`;
    licenseId = randomUUID();
    syncId = randomUUID();
    licId = randomUUID();

    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Device Link Tenant', ${`dlk-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
      `);
      await db.execute(sql`
        insert into licenses (id, key, type, status, max_devices, tenant_id)
        values (${licenseId}, ${`KEY-${licenseId.slice(0, 8)}`}, 'full', 'active', 5, ${tenantId})
      `);
    });
    await runWithTenantContext({ tenantId }, async () => {
      await db.execute(sql`
        insert into sync_devices (id, tenant_id, device_fingerprint, platform, last_seen_at)
        values (${syncId}, ${tenantId}, ${fingerprint}, 'windows', now())
      `);
      await db.execute(sql`
        insert into device_registrations
          (id, license_id, tenant_id, device_id, device_fingerprint, platform, last_seen_at)
        values (${licId}, ${licenseId}, ${tenantId}, ${randomUUID()}, ${fingerprint}, 'windows', now())
      `);
    });
  });

  afterAll(async () => {
    if (!reachable || !tenantId) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_devices where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from device_registrations where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from licenses where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("revoking sync by fingerprint stamps matching license rows, and vice versa", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);

    await revokeSyncDevicesByFingerprint(db, tenantId, fingerprint, true, "test_link");
    await runWithTenantContext({ tenantId }, async () => {
      const afterSync = await db.execute<{ ra: Date | null }>(sql`
        select revoked_at as ra from sync_devices where id = ${syncId}
      `);
      expect((afterSync.rows?.[0] as { ra: Date | null } | undefined)?.ra).not.toBeNull();
    });

    await revokeLicenseDevicesByFingerprint(db, tenantId, fingerprint, true, "test_link");
    await runWithTenantContext({ tenantId }, async () => {
      const afterLic = await db.execute<{ ra: Date | null }>(sql`
        select revoked_at as ra from device_registrations where id = ${licId}
      `);
      expect((afterLic.rows?.[0] as { ra: Date | null } | undefined)?.ra).not.toBeNull();
    });
  });
});
