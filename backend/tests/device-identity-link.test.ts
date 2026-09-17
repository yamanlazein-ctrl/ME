import { describe, expect, it } from "vitest";
import { pool } from "../src/infrastructure/orm/drizzle.js";
import {
  revokeLicenseDevicesByFingerprint,
  revokeSyncDevicesByFingerprint,
} from "../src/infrastructure/device/linkedDeviceRevocation.js";
import { db } from "../src/infrastructure/orm/drizzle.js";

describe("license ↔ sync device fingerprint link", () => {
  it("revoking sync by fingerprint stamps matching license rows, and vice versa", async () => {
    const t = await pool.query<{ id: string }>(`SELECT id::text AS id FROM tenants LIMIT 1`);
    const tenantId = t.rows[0]?.id;
    if (!tenantId) throw new Error("no tenant");
    await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
    const pair = await pool.query<{
      tenant_id: string;
      fingerprint: string;
      sync_id: string;
      lic_id: string;
    }>(`
      SELECT s.tenant_id::text, s.device_fingerprint AS fingerprint, s.id::text AS sync_id, d.id::text AS lic_id
        FROM sync_devices s
        JOIN device_registrations d
          ON d.tenant_id = s.tenant_id AND d.device_fingerprint = s.device_fingerprint
       WHERE s.revoked_at IS NULL AND d.revoked_at IS NULL
       LIMIT 1
    `);
    if (!pair.rows[0]) {
      throw new Error("no matching fingerprint on sync_devices and device_registrations");
    }
    const { tenant_id, fingerprint, sync_id, lic_id } = pair.rows[0];
    try {
      await revokeSyncDevicesByFingerprint(db, tenant_id, fingerprint, true, "test_link");
      const afterSync = await pool.query<{ ra: Date | null }>(
        `SELECT revoked_at AS ra FROM sync_devices WHERE id = $1`,
        [sync_id],
      );
      expect(afterSync.rows[0]?.ra).not.toBeNull();

      await revokeLicenseDevicesByFingerprint(db, tenant_id, fingerprint, true, "test_link");
      const afterLic = await pool.query<{ ra: Date | null }>(
        `SELECT revoked_at AS ra FROM device_registrations WHERE id = $1`,
        [lic_id],
      );
      expect(afterLic.rows[0]?.ra).not.toBeNull();
    } finally {
      await revokeSyncDevicesByFingerprint(db, tenant_id, fingerprint, false, null);
      await revokeLicenseDevicesByFingerprint(db, tenant_id, fingerprint, false, null);
    }
  });
});
