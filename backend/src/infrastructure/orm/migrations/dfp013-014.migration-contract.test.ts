import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here);

function readMigration(name: string): string {
  return readFileSync(resolve(migrationsDir, name), "utf8");
}

describe("DFP-013 / DFP-014 migration SQL contracts", () => {
  it("DFP-013 defines composite tenant/license FKs", () => {
    const sql = readMigration("20260921_tenant_license_composite_fk.sql");
    expect(sql).toMatch(/licenses_tenant_id_uidx/);
    expect(sql).toMatch(/invitation_codes_tenant_license_fk/);
    expect(sql).toMatch(/device_registrations_tenant_license_fk/);
    expect(sql).toMatch(/FOREIGN KEY \(tenant_id, license_id\)/);
    expect(sql).toMatch(/REFERENCES licenses \(tenant_id, id\)/);
  });

  it("DFP-014 defines sync_device_authorized_users with tenant FKs", () => {
    const sql = readMigration("20260922_sync_device_authorized_users.sql");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sync_device_authorized_users/);
    expect(sql).toMatch(/sync_device_authorized_users_device_fk/);
    expect(sql).toMatch(/sync_device_authorized_users_user_fk/);
    expect(sql).toMatch(/REFERENCES sync_devices \(tenant_id, id\)/);
    expect(sql).toMatch(/REFERENCES users \(tenant_id, id\)/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("DFP-018 force-enables RLS on every tenant_id table", () => {
    const sql = readMigration("20260923_force_rls_all_tenant_tables.sql");
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/attname = 'tenant_id'/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });
});
