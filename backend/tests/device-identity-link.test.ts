import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/infrastructure/orm/drizzle.js";
import {
  revokeLicenseDevicesByFingerprint,
  revokeSyncDevicesByFingerprint,
} from "../src/infrastructure/device/linkedDeviceRevocation.js";
import { db } from "../src/infrastructure/orm/drizzle.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

describe("license ↔ sync device fingerprint link", () => {
  it("revoking sync by fingerprint stamps matching license rows, and vice versa", async () => {
    // FIN-09: this used to hunt for a pre-existing sync_devices ↔
    // device_registrations pair, so it only ran on a database that happened to
    // carry one and threw on a clean one. It now seeds its own linked pair.
    if (!(await databaseReachable())) return;

    const tenant_id = randomUUID();
    const fingerprint = `fp-${randomUUID()}`;
    const licenseId = randomUUID();
    const sync_id = randomUUID();
    const lic_id = randomUUID();

    await pool.query(
      `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
       VALUES ($1, 'Device Link Tenant', $2, 'active', 'no_license', 'trial')`,
      [tenant_id, `dlk-${tenant_id.slice(0, 8)}`],
    );
    await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenant_id]);
    await pool.query(
      `INSERT INTO licenses (id, key, type, status, max_devices, tenant_id)
       VALUES ($1, $2, 'full', 'active', 5, $3)`,
      [licenseId, `KEY-${licenseId.slice(0, 8)}`, tenant_id],
    );
    await pool.query(
      `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, last_seen_at)
       VALUES ($1, $2, $3, 'windows', now())`,
      [sync_id, tenant_id, fingerprint],
    );
    await pool.query(
      `INSERT INTO device_registrations
         (id, license_id, tenant_id, device_id, device_fingerprint, platform, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'windows', now())`,
      [lic_id, licenseId, tenant_id, randomUUID(), fingerprint],
    );

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
